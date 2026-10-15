import type { Mascot } from "../theme/theme-design";
import { ART } from "./maid-art";

/**
 * What the maids say and how they may stand (the Unreal build's RhineThemeFx.cpp: PatLine, the companion's greetings
 * and idle lines, the terminal's, Looks). Every line is Claude's, then DeepSeek's livelier one.
 */
export const pick = (who: Mascot, claude: string, deepseek: string) => who === "deepseek" ? deepseek : claude;

/** The interface face her bubbles are written in. */
let face = "";
export const uiFace = () => face ||= getComputedStyle(document.body).fontFamily;

/** What she says to a pat: the more of them in twenty seconds, the less composed. */
export function patLine(who: Mascot, pats: number, turn: number) {
  const claude = [
    ["嗯……主人的手好暖。", "欸嘿，被摸头了。", "有什么吩咐吗，主人？"],
    ["头、头饰要歪了啦……", "主人今天很闲吗？", "再摸下去我要没法工作了……"],
    ["主人！再摸就要按 token 计费了！", "呜……真拿您没办法。", "好啦好啦，我在这儿，哪儿也不去。"],
  ];
  const whale = [
    ["嘿嘿～主人的手好暖！", "噗噜噜，被摸头啦～", "主人有新任务吗？冲冲冲！"],
    ["头、头饰要被摸歪啦！", "主人今天好闲哦～一起摸鱼吗？", "再摸我就要喷水了哦！"],
    ["主人！再摸要收小鱼干了！", "唔……好吧好吧，随便摸～", "我就在这儿，哪儿也不游走！"],
  ];
  const rows = who === "deepseek" ? whale : claude;
  return rows[pats <= 2 ? 0 : pats <= 5 ? 1 : 2][((turn % 3) + 3) % 3];
}

/** Her greeting as she arrives on the home, by the hour. */
export function greeting(who: Mascot, hour = new Date().getHours()) {
  return hour < 5 ? pick(who, "这么晚了……主人还不休息吗？", "都几点啦！主人快去睡觉！")
    : hour < 11 ? pick(who, "早上好，主人。今天也请多指教。", "早上好主人！今天也全速前进！")
    : hour < 14 ? pick(who, "中午好，主人，吃过饭了吗？", "中午好主人！饭吃了没？我分你一条鱼～")
    : hour < 18 ? pick(who, "下午好，主人。", "下午好主人！精神满满！")
    : hour < 23 ? pick(who, "晚上好，主人，辛苦了。", "晚上好主人，今天辛苦啦～")
    : pick(who, "夜深了，主人，别熬太晚。", "夜深啦主人，别熬太晚哦！");
}

/** Left alone for forty seconds on the home; the first comes with her tea (her snack). */
export const IDLE: Record<Mascot, readonly string[]> = {
  claude: ["主人，要不要喝杯茶？", "档案我都擦过一遍了。", "……（偷偷打了个哈欠）", "要连哪台主机，吩咐一声就好。", "我会一直在这儿等着的。"],
  deepseek: ["主人，来块鲷鱼烧吗？", "档案我都巡逻过一遍啦！", "……（偷偷吐了个泡泡）", "要连哪台？说一声我就游过去！", "我会一直在这儿守着哒！"],
};

/**
 * How she stands in the terminal when nothing happens (RhineThemeFx.cpp Looks): her bust (-1) or one picture of
 * ART. With reacting on, a picture gives way to the pose of the moment.
 */
const LOOKS: readonly { name: string; art: number }[] = [
  { name: "半身像", art: -1 }, { name: "站立", art: ART.stand }, { name: "托腮", art: ART.lean }, { name: "眺望", art: ART.lookout },
  { name: "挥手", art: ART.wave }, { name: "端茶", art: ART.tea }, { name: "加油", art: ART.cheer }, { name: "鞠躬", art: ART.bow },
  { name: "生气", art: ART.angry }, { name: "修服务器", art: ART.fix }, { name: "庆祝", art: ART.celebrate }, { name: "打瞌睡", art: ART.doze },
];
export const LOOK_COUNT = LOOKS.length;
export const lookArt = (look: number) => LOOKS[Math.max(0, Math.min(LOOK_COUNT - 1, look))].art;
export function lookName(who: Mascot, look: number) {
  const { name, art } = LOOKS[Math.max(0, Math.min(LOOK_COUNT - 1, look))];
  // Hers where they differ: the salute in the bow's place, a snack in the tea's.
  if (who === "deepseek") { if (art === ART.lookout) return "敬礼远望"; if (art === ART.bow) return "敬礼"; if (art === ART.tea) return "吃鲷鱼烧"; }
  return name;
}

/**
 * A line of talk broken to a bubble no wider than `wide`: after a space where the run is Latin, between any two
 * characters otherwise (Chinese has no spaces). `max` lines at most, the last ending in an ellipsis.
 */
export function wrap(ctx: CanvasRenderingContext2D, text: string, wide: number, max: number) {
  const lines: string[] = [];
  let line = "";
  for (const c of text) {
    if (c === "\n" || c === "\r") { if (line) lines.push(line); line = ""; continue; }
    line += c;
    if ([...line].length < 2 || ctx.measureText(line).width <= wide) continue;
    const chars = [...line];
    let cut = chars.length - 1;
    const space = line.lastIndexOf(" ");
    if (c.charCodeAt(0) < 128 && space > 0) cut = [...line.slice(0, space + 1)].length;
    lines.push(chars.slice(0, cut).join("").trimEnd());
    line = chars.slice(cut).join("");
  }
  if (line.trimEnd()) lines.push(line);
  if (lines.length > max) { lines.length = max; lines[max - 1] = [...lines[max - 1]].slice(0, -1).join("") + "…"; }
  return lines;
}
