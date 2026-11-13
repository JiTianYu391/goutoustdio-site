# GoutouStdio 官网

GoutouStdio 小组官方网站，部署在 FadeHost，域名 [goutoustdio.top](https://goutoustdio.top)。

本站内容从 [ViudiraTech/PySpOS](https://github.com/ViudiraTech/PySpOS) 仓库的 `docs/` 文件夹拆出，是纯静态站（HTML + CSS + JS，动画用本地 GSAP / Lenis），FadeHost 直接按静态站托管。

## 大文件说明

下载用的大文件（两个 Uinxed ISO、OTA 更新包 zip）和两张截图因为是二进制文件，没有放进这个仓库，相关链接指向原 PySpOS 仓库的 raw 地址：

- `Uinxed-x64-slim.iso`、`spaceos8/Uinxed-x64-slim.iso`
- `ota/PySpOS-*.zip`（`ota/version.json` 里的 `download_url` 也是）
- `spaceos8-minecraft.png`、`spaceos9/fastfetch.png`（页面里的两张截图）

`logo.png` 和 `spaceos9.png` 在原 docs 里没有被任何页面引用，也没有放进这个仓库。

如果以后想让本站完全自包含，把这些文件传进本仓库，再把链接改回相对路径即可。
