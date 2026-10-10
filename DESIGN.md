---
name: RhineLab
description: 「莱茵生命：访问」终端界面复刻与 SSH 工作区
colors:
  paper: "#e8e5e1"
  ink: "#080a08"
  signal-mint: "#20c997"
  champagne-focus: "#a67d48"
  selection-sand: "#cbb397"
  night-paper: "#131e26"
  night-ink: "#e2e9e7"
  night-signal-lemon: "#e4f03a"
  risk-low: "#3d6b60"
  risk-medium: "#835b32"
  risk-high: "#a44534"
  terminal-error: "#a8412f"
typography:
  display:
    fontFamily: "Barlow Condensed, MiSans, Microsoft YaHei, sans-serif"
    fontWeight: 800
  body:
    fontFamily: "MiSans, Mi Sans, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "15px"
  label:
    fontFamily: "JetBrains Mono, MiSans, Consolas, monospace"
rounded:
  none: "0"
  round: "50%"
spacing:
  unit: "8px"
---

# Design System: RhineLab

## Overview

**Creative North Star: "档案标签"**

界面是一张贴在实物上的档案标签：暖纸底、墨色字、一块纯色信号色。巨型压缩数字编号按大写字高排版，色块切一个 45° 角，分隔全靠 3px 和 2px 的墨线。三维档案阵列是真实的物件，界面只是贴在它旁边的标签。

密度偏高但不拥挤：编号、状态、地址都直接露出，不藏进菜单。动效服务于"档案被取出、被读取"的过程，不做装饰性弹跳。

**Key Characteristics:**
- 底色、墨色、一块信号色，每个主题只有这三样
- 巨型压缩数字编号
- 45° 切角色块，直角，无圆角卡片
- 墨线分隔，不靠阴影分层
- 中文正文配英文小号等宽注记（`FILE NO. / 档案编号`）

## Colors

每个主题一套：底、墨、一块信号色。frontmatter 里是纸档（默认）和夜间两套的实测值；其余八套见 `src/features/theme/theme-design.ts`，那里是唯一来源。

### Primary
- **薄荷信号** (`signal-mint`)：纸档主题的信号色。用在当前档案的标签块和唯一的主操作（添加主机、读取档案）。

### Neutral
- **暖纸** (`paper`)：全局底色。
- **墨** (`ink`)：文字、线条、选中态的实底。
- **香槟金** (`champagne-focus`)：键盘焦点框。
- **沙色** (`selection-sand`)：文字选区。

### 状态色
- **低 / 中 / 高** (`risk-low` / `risk-medium` / `risk-high`)：SSH 监控与负载读数，深色主题下有对应的浅色版本。
- **终端错误** (`terminal-error`)：终端里的错误输出。

### Named Rules
**The One Signal Rule.** 一屏只有一块信号色，压在它上面的字用 `--on-signal`，不用主题墨色。

**The Both Repos Rule.** 主题数值在 Unreal 仓库的 `RhineTheme.cpp` 里也有一份，改一处必须改两处。

## Typography

**Display Font:** Barlow Condensed（600/700/800），回退 MiSans
**Body Font:** MiSans，回退 PingFang SC、Microsoft YaHei
**Label/Mono Font:** JetBrains Mono，回退 MiSans

**Character:** 压缩无衬线负责数字和编号的体量，MiSans 负责中文的可读，等宽负责"机器打印"的注记。

### Hierarchy
- **Display**：档案编号和计数（`H—000`、`02`），按大写字高设定尺寸。
- **Title**：档案名、区块名，MiSans 粗体。
- **Body** (15px)：正文。检索输入 16px。
- **Label**：等宽大写英文加中文对照的小注记。

### Named Rules
**The Cap Height Rule.** 巨型数字按大写字高对齐色块边缘，不按行高。

## Layout

桌面是一个固定 1920×1080 的舞台，整体缩放，元素绝对定位。窄屏和竖屏改用真实 CSS 像素布局，文字和按钮不整体缩小。

- 横屏：左侧模型，右侧档案。
- 竖屏：正文从屏高 54% 开始，上方留给模型。
- 主要操作触控高度至少 44px；四周读取安全区域。
- 间距基准 8px。

## Elevation & Depth

平面为主。分层靠墨线、实底色块和三维场景本身的景深，不靠界面阴影。弹窗用一层环境阴影（`0 24px 72px rgb(0 0 0 / 14%)`）与场景隔开。

### Named Rules
**The Ink Rule Rule.** 区块之间用 3px 或 2px 墨线分开，不加投影。

## Shapes

直角。色块在一个角上切 45°（切角尺寸随色块大小取 22px 到 44px）。圆形只用于模型和真正的圆形标记。没有圆角卡片。

## Components

### Buttons
- **Shape:** 直角，2px 墨线描边。
- **Primary:** 信号色实底，切一个角，一屏一个。
- **Selected:** 墨色实底，底色文字。
- **Focus:** 2px 香槟金外框，偏移 7px。

### Chips
- **Style:** 小号墨线框，粗体文字，用于状态（未连接、可读取）。

### Inputs / Fields
- **Style:** 无框，底部一条墨线，左侧图标。

### Navigation
- 顶部条：品牌标志加编号导航（`01 档案阵列`）。
- 页签：编号加名称，选中项墨色实底并切角。

### 档案标签块（签名组件）
信号色底、巨型编号、档案名、英文注记、状态标签、像素徽记，右下角切 45°。

## Do's and Don'ts

### Do:
- **Do** 保留原片的布局、字体和暖纸配色，即使它不符合常规网页规范。
- **Do** 压在信号色上的文字用 `--on-signal`。
- **Do** 用墨线和实底表达层级。
- **Do** 改主题数值时同步 Unreal 仓库。

### Don't:
- **Don't** 加圆角卡片或用投影分层。
- **Don't** 在一屏里出现第二块信号色。
