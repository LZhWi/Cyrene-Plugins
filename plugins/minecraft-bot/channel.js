"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinecraftChannelAdapter = void 0;
/** 原版聊天单条长度上限（超长会被服务器拒绝）。 */
const GAME_CHAT_LINE_LIMIT = 256;
/**
 * 多行回复逐条发送的间隔。原版服务端每发一条聊天给 chatSpamTickCount 加 20、每 tick 减 1，
 * 累计超过 200 就以 disconnect.spam 踢人，也就是持续超过 1 条/秒必被踢；350ms 实测发到第 16 条掉线。
 */
const LINE_SEND_INTERVAL_MS = 1200;
/** 单次回复最多发出多少行（含省略提示），超出即截断，避免把聊天栏刷屏。 */
const MAX_SEND_LINES = 10;
/** 折行时优先断开的位置（中英文句读）。 */
const BREAK_AFTER = /[，。！？；：、,.!?;:]\s*|\s+/g;
/** GFM 表格的一行拆成单元格；不是表格行则返回 null。 */
function tableCells(line) {
    const matched = /^[ \t]*\|(.+)\|[ \t]*$/.exec(line);
    return matched ? matched[1].split("|").map((cell) => cell.trim()) : null;
}
/**
 * 把 markdown 表格摊平成可读行：分隔行丢掉，两列表写成「键：值」，多列表用顿号连接。
 * 游戏聊天栏没有等宽对齐，原样发出只会是一串竖线。
 */
function flattenTables(text) {
    const lines = text.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const cells = tableCells(lines[i]);
        if (!cells) {
            out.push(lines[i]);
            continue;
        }
        const separator = tableCells(lines[i + 1] ?? "");
        if (separator && separator.every((cell) => /^:?-+:?$/.test(cell)))
            i++;
        const kept = cells.filter((cell) => cell.length > 0);
        out.push(kept.length === 2 ? `${kept[0]}：${kept[1]}` : kept.join("、"));
    }
    return out.join("\n");
}
/**
 * 把模型可能产出的 markdown 洗成游戏聊天栏能看的纯文本。
 * 频道声明 markdown:false，但宿主不会替我们转换，所以必须在这里做，
 * 否则 **加粗**、``` 围栏会原样出现在玩家眼前。
 */
function toGamePlainText(text) {
    return flattenTables(String(text ?? ""))
        // 代码围栏：丢掉 ``` 标记行，保留里面的内容
        .replace(/^[ \t]*```[^\n]*\n?|[ \t]*```[ \t]*$/gm, "")
        .replace(/`([^`]+)`/g, "$1")
        // 标题、引用
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
        .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
        // 列表符号统一成中点
        .replace(/^[ \t]*([-*+])[ \t]+/gm, "· ")
        .replace(/^[ \t]*\d+\.[ \t]+/gm, "· ")
        // 加粗与斜体（含 __x__ 与 *x*），成对的先走，避免吃掉乘号
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
        .replace(/(^|[^*\w])\*(?=\S)([^*\r\n]*?\S)\*(?!\*)/g, "$1$2")
        .replace(/(^|[^_\w])_(?=\S)([^_\r\n]*?\S)_(?!_)/g, "$1$2")
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
        // 链接与图片
        .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, "$1（$2）")
        .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
}
/**
 * 按 256 上限折行：优先在句读或空格处断开，实在没有断点才硬切，
 * 避免旧实现那样把一句话从中间劈成两半。
 */
function wrapForGameChat(text, limit = GAME_CHAT_LINE_LIMIT) {
    const out = [];
    for (const raw of toGamePlainText(text).split("\n")) {
        let line = raw.trim();
        if (!line)
            continue;
        while (line.length > limit) {
            const window = line.slice(0, limit);
            let cut = 0;
            for (const m of window.matchAll(BREAK_AFTER)) {
                const end = m.index + m[0].length;
                if (end > cut)
                    cut = end;
            }
            if (cut < Math.floor(limit / 4))
                cut = limit; // 没有合适断点，只能硬切
            out.push(line.slice(0, cut).trim());
            line = line.slice(cut).trim();
        }
        if (line)
            out.push(line);
    }
    return out.map((l) => l.slice(0, limit)).filter((l) => l.length > 0);
}
const CAPABILITY = {
    text: true,
    image: false,
    audio: false,
    file: false,
    video: false,
    markdown: false,
    card: false,
    sticker: false,
    maxTextLength: GAME_CHAT_LINE_LIMIT,
};
class MinecraftChannelAdapter {
    bridge;
    id = "minecraft";
    displayName = "Minecraft";
    capability = CAPABILITY;
    onMessage = null;
    /** 退订函数集合；stop() 时统一清理。 */
    unsubs = [];
    constructor(bridge) {
        this.bridge = bridge;
    }
    async start() {
        // 订阅游戏聊天：玩家发言 → 归一化 → 交给宿主调度器跑一轮 Agent
        this.unsubs.push(this.bridge.onChat((player, message) => void this.handleGameChat(player, message)));
        // 状态订阅仅为让宿主感知连接变化（日志层面），无需额外处理
        this.unsubs.push(this.bridge.onStateChange((state) => {
            if (state === "connected") {
                // 连接建立后频道即活；无需通知，getStatus() 是轮询式
            }
        }));
    }
    async stop() {
        for (const unsub of this.unsubs)
            unsub();
        this.unsubs = [];
    }
    /** 玩家发言转宿主入站消息；onMessage 的返回值由调度器负责投递，这里不重发。 */
    async handleGameChat(player, message) {
        if (!this.onMessage)
            return;
        const status = this.bridge.status();
        const inMsg = {
            channel: this.id,
            // 游戏聊天本质是所有人共享的公共频道
            chatType: "group",
            messageId: `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            senderId: player,
            senderName: player,
            chatId: status.host ? `${status.host}:${status.port ?? 25565}` : "minecraft-server",
            text: message,
            at: new Date(),
        };
        try {
            await this.onMessage(inMsg);
        }
        catch (err) {
            // 调度器内部已记日志；这里兜底防异常冒泡到 bridge 的事件循环
            console.error("[minecraft-channel] 调度器处理消息失败:", err);
        }
    }
    /** 出站：把统一消息的文本部分按行拆开，让机器人逐条在游戏里发言。 */
    async send(message) {
        if (this.bridge.status().state !== "connected") {
            return { ok: false, error: "机器人未连接服务器" };
        }
        const text = message.parts
            .filter((p) => p.kind === "text" && typeof p.text === "string")
            .map((p) => String(p.text))
            .join("\n");
        const lines = wrapForGameChat(text);
        if (lines.length === 0)
            return { ok: true };
        const capped = lines.slice(0, MAX_SEND_LINES - 1);
        if (lines.length > capped.length)
            capped.push(`…（回复过长，余下 ${lines.length - capped.length} 行省略）`);
        try {
            for (let i = 0; i < capped.length; i++) {
                if (i > 0)
                    await new Promise((r) => setTimeout(r, LINE_SEND_INTERVAL_MS));
                // 中途掉线时如实报失败：否则宿主会把只发出去一半的回复记成 delivered。
                if (this.bridge.status().state !== "connected")
                    return { ok: false, error: `机器人已断开，剩余 ${capped.length - i} 行未发出` };
                this.bridge.say(capped[i]);
            }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    getStatus() {
        const status = this.bridge.status();
        if (status.state === "connected") {
            return {
                enabled: true,
                phase: "running",
                message: `已连接 ${status.host}:${status.port}（${status.username}）`,
            };
        }
        if (status.state === "connecting")
            return { enabled: true, phase: "starting", message: "正在连接服务器" };
        return { enabled: true, phase: "offline", message: "机器人未连接，用连接工具接入服务器后频道自动生效" };
    }
}
exports.MinecraftChannelAdapter = MinecraftChannelAdapter;
exports.toGamePlainText = toGamePlainText;
exports.wrapForGameChat = wrapForGameChat;
