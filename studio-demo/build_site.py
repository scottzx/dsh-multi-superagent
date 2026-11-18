#!/usr/bin/env python3
"""Build the ModelScope Studio demo docs site from the repository markdown.

Usage: python3 studio-demo/build_site.py
Output: studio-demo/site/ (committed; the Docker image serves it on port 7860)
"""
import pathlib
import re

import markdown

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "studio-demo" / "site"
UPSTREAM = "https://github.com/deepseek-ai/dsh-superagent-prototype"

MD = markdown.Markdown(extensions=["extra", "toc", "sane_lists"])

PAGES = [
    ("index.html", "README.md", "首页", False),
    ("setup.html", "SETUP.md", "快速开始 SETUP", False),
]
for _src in sorted((ROOT / "docs").glob("*.md")):
    PAGES.append((f"docs/{_src.stem}.html", f"docs/{_src.name}", _src.stem, True))

STYLE = """
:root {
  --bg: #f8fafc; --panel: #ffffff; --ink: #0f172a; --muted: #64748b;
  --accent: #2563eb; --accent-ink: #ffffff; --line: #e2e8f0; --code-bg: #f1f5f9;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
.sidebar {
  position: fixed; inset: 0 auto 0 0; width: 260px; overflow-y: auto;
  background: var(--panel); border-right: 1px solid var(--line); padding: 24px 16px;
}
.sidebar .brand { display: block; font-size: 20px; font-weight: 700; color: var(--ink); text-decoration: none; }
.sidebar .brand span { display: block; font-size: 12px; font-weight: 500; color: var(--muted); letter-spacing: .12em; margin-top: 2px; }
.sidebar nav { margin-top: 24px; }
.sidebar .group { margin: 18px 0 6px; font-size: 11px; letter-spacing: .14em; color: var(--muted); text-transform: uppercase; }
.sidebar a.nav {
  display: block; padding: 6px 10px; border-radius: 8px; color: var(--ink);
  text-decoration: none; font-size: 14px;
}
.sidebar a.nav:hover { background: var(--code-bg); }
.sidebar a.nav.active { background: var(--accent); color: var(--accent-ink); }
.sidebar footer { margin-top: 28px; font-size: 12px; color: var(--muted); }
main { margin-left: 260px; padding: 40px 48px 80px; max-width: 980px; }
.hero {
  background: linear-gradient(135deg, #1e3a8a, #2563eb 55%, #0ea5e9);
  color: #fff; border-radius: 18px; padding: 40px 40px 36px; margin-bottom: 32px;
}
.hero h1 { margin: 0 0 10px; font-size: 34px; }
.hero p { margin: 0 0 22px; font-size: 17px; opacity: .92; max-width: 46em; }
.hero .btns a {
  display: inline-block; margin: 0 10px 10px 0; padding: 10px 18px; border-radius: 10px;
  background: #fff; color: #1e3a8a; font-weight: 600; text-decoration: none; font-size: 14px;
}
.hero .btns a.ghost { background: rgba(255,255,255,.16); color: #fff; }
.notice {
  background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
  border-radius: 12px; padding: 14px 18px; margin: 0 0 28px; font-size: 14px;
}
.content { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 8px 36px 28px; }
.content h1 { font-size: 28px; margin-top: 26px; }
.content h2 { font-size: 21px; margin-top: 34px; padding-top: 10px; border-top: 1px solid var(--line); }
.content h3 { font-size: 17px; margin-top: 26px; }
.content a { color: var(--accent); }
.content img { max-width: 100%; }
.content blockquote {
  margin: 16px 0; padding: 10px 18px; border-left: 4px solid var(--accent);
  background: var(--code-bg); border-radius: 0 10px 10px 0; color: var(--muted);
}
code { background: var(--code-bg); border-radius: 6px; padding: 2px 6px; font-size: .9em; }
pre { background: var(--code-bg); border-radius: 12px; padding: 16px 18px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
th { background: var(--code-bg); }
@media (max-width: 860px) {
  .sidebar { position: static; width: auto; border-right: none; border-bottom: 1px solid var(--line); }
  main { margin-left: 0; padding: 24px 18px 60px; }
  .content { padding: 4px 18px 22px; }
}
""".strip()

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · dsh-superagent 演示</title>
<link rel="stylesheet" href="{prefix}assets/style.css">
</head>
<body>
<aside class="sidebar">
  <a class="brand" href="{prefix}index.html">dsh-superagent<span>MODELSCOPE STUDIO 演示</span></a>
  <nav>{nav}</nav>
  <footer>部署于 ModelScope 创空间 · Docker</footer>
</aside>
<main>
{hero}<article class="content">
{body}
</article>
</main>
</body>
</html>
"""

HERO = """<section class="hero">
  <h1>dsh-superagent</h1>
  <p>面向单个 GitHub 仓库的主动式编码智能体（DeepSeek Harness Bundle）：监听 GitHub 与飞书，
  按团队规则把请求变成工作项，在独立会话里完成任务，用 Pull Request 或对话回复交付结果，
  配一块面板告诉人「哪里需要人」。</p>
  <div class="btns">
    <a href="docs/000-philosophy.html">阅读设计文档</a>
    <a class="ghost" href="setup.html">部署指南 SETUP</a>
    <a class="ghost" href="https://github.com/deepseek-ai/dsh-superagent-prototype" target="_blank" rel="noopener">GitHub 源码</a>
  </div>
</section>
<div class="notice">本页面是 <b>演示环境（文档站）</b>：展示项目文档与完整源码。
dsh-superagent 本体是 DeepSeek Harness 的插件包，完整运行需要 DSH 运行时、独立的 Agent GitHub 账号等条件，
请按 <a href="setup.html">SETUP.md</a> 在你自己的环境部署。</div>
"""


def rewrite(html: str, prefix: str) -> str:
    """Rewrite in-repo markdown links to the generated pages.

    Bare ``*.md`` links stay in the current directory (docs pages link siblings);
    ``README.md``/``SETUP.md`` move up to the site root on docs pages.
    """

    def sub(m: re.Match) -> str:
        href, frag = m.group(1), ""
        if "#" in href:
            href, frag = href.split("#", 1)
            frag = "#" + frag
        if href == "LICENSE":
            return f'href="{UPSTREAM}/blob/main/LICENSE"'
        if href == "README.md":
            return f'href="{prefix}index.html{frag}"'
        if href == "SETUP.md":
            return f'href="{prefix}setup.html{frag}"'
        if href.startswith("docs/"):
            name = href[len("docs/"):-3] if href.endswith(".md") else href[len("docs/"):]
            target = f"{name}.html" if href.endswith(".md") else href[len("docs/"):]
            return f'href="{target if prefix else f"docs/{target}"}{frag}"'
        if href.endswith(".md"):
            return f'href="{href[:-3]}.html{frag}"'
        return m.group(0)

    return re.sub(r'href="([^"]+)"', sub, html)


def build_nav(active: str, is_docs: bool, prefix: str) -> str:
    items = ['<div class="group">概览</div>']
    for out, _src, label, _d in PAGES[:2]:
        target = f"{prefix}{out}" if is_docs else out
        items.append(f'<a class="nav{" active" if out == active else ""}" href="{target}">{label}</a>')
    items.append('<div class="group">设计文档</div>')
    for out, _src, label, _d in PAGES[2:]:
        target = out[len("docs/"):] if is_docs else out
        items.append(f'<a class="nav{" active" if out == active else ""}" href="{target}">{label}</a>')
    return "".join(items)


def main() -> None:
    titles, bodies = {}, {}
    for out, src, _label, _is_docs in PAGES:
        text = (ROOT / src).read_text(encoding="utf-8")
        m = re.search(r"^#\s+(.+)$", text, re.M)
        titles[out] = m.group(1).strip() if m else src
        MD.reset()
        bodies[out] = MD.convert(text)

    for out, src, _label, is_docs in PAGES:
        prefix = "../" if is_docs else ""
        nav = build_nav(out, is_docs, prefix)
        hero = HERO if out == "index.html" else ""
        body = rewrite(bodies[out], prefix)
        page = TEMPLATE.format(title=titles[out], prefix=prefix, nav=nav, hero=hero, body=body)
        dest = OUT / out
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(page, encoding="utf-8")
        print("wrote", dest.relative_to(ROOT))

    assets = OUT / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "style.css").write_text(STYLE + "\n", encoding="utf-8")
    print("wrote", (assets / "style.css").relative_to(ROOT))


if __name__ == "__main__":
    main()
