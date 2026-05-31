---
title: "Hello nodeaitry.com"
date: 2026-05-28T22:50:00+08:00
description: "nodeaitry.com 的第一篇文章。"
tags: ["nodeaitry", "hugo", "papermod"]
categories: ["site"]
draft: false
ShowToc: true
TocOpen: true
---

这是 nodeaitry.com 的第一篇文章。

站点使用 Hugo 和 PaperMod 主题搭建，保留了 PaperMod 的轻量、快速、响应式、深色模式、归档、搜索和文章目录等能力。

后续可以在 `content/posts/` 下继续新增文章。每篇文章都可以通过 front matter 配置标题、日期、标签、分类、封面图和目录行为。

代码高亮示例：

```js
const site = {
  name: "nodeaitry.com",
  stack: ["Hugo", "PaperMod", "Cloudflare"],
};

console.log(site.stack.join(" + "));
```
