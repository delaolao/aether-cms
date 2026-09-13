# 现成的标签别名文件（由 `tools/tag-audit.mjs --emit-aliases` 生成）

这两个站点的标签别名文件已经生成好，**复制到实例里即可生效**（2 秒内自动重载，无需重启 node；删掉文件即完全回滚）。

| 文件 | 内容 | 适用场景 |
|---|---|---|
| `xl.dleu.net.json` | 合并 1 条：`MarkDown` → `markdown` | 只做「同义归一」，最保守 |
| `xl.dleu.net.plus-demo-drop.json` | 合并 1 条 + 丢弃 7 个演示噪声标签（`wiki`/`公式`/`吉他`/`Aether CMS`/`graph`/`hblog-ng`/`KaTeX`） | 顺带做 G1（隐藏上游示例文章带来的噪声标签） |
| `xq.dleu.net.json` | 合并 2 条：`MarkDown` → `markdown`、`cpu` → `中央处理器` | 只做「同义归一」 |
| `xq.dleu.net.plus-demo-drop.json` | 合并 2 条 + 丢弃 8 个演示噪声标签（含 `王若琳`） | 顺带做 G1 |

## 怎么用

```bash
# 以 xl 实例为例（实例目录：/data/te_se_zi_yuan/xl/aether-cms）
cp docs/tag-aliases/xl.dleu.net.plus-demo-drop.json /data/te_se_zi_yuan/xl/aether-cms/content/data/tag-aliases.json
# 2 秒后刷新页面即可看到：标签云里 MarkDown 与 markdown 合并为一条，
# 演示噪声标签消失；/tag/MarkDown 会 301 跳到 /tag/markdown
```

回滚：`rm /data/.../content/data/tag-aliases.json`（或把它改回上一版），2 秒内恢复原状。

## 生成时自动做的两道安全检查

1. **别名的规范名不会被丢弃**：例如 `markdown` 是 `MarkDown` 的规范名，虽然它出现在「演示噪声标签」名单里，也不会写进 `drop`（否则别名解析完又立刻被丢掉）。文件里的 `notes` 会写明原因。
2. **被非演示文章使用的标签会单独提示**：若某个要丢弃的标签还挂在真实文章上，`notes` 会写明「还被 N 篇非演示文章使用（标题…），丢弃后这些文章会失去该标签——如不接受请从 drop 里删掉它」。

> 这两道检查来自一次真实踩坑：最初的 `drop` 列表里同时含 `markdown` 与 `MarkDown`，会让 `MarkDown → markdown` 这条别名失去意义。

## 建议的使用顺序（G1 是最小动作）

1. 先复制 **`*.json`（不含 demo-drop）**，只看「同义合并」效果；
2. 确认没问题后再换成 **`*.plus-demo-drop.json`**（隐藏演示噪声标签，文章本身仍在）；
3. 若之后决定把这些上游示例文章**转草稿或删除**（G2/G3，见 `TAG-GOVERNANCE.md`），再把 `drop` 里对应的条目删掉即可——那时它们已经不会被任何文章引用。

## 重新生成（内容变化后）

```bash
node tools/tag-audit.mjs https://xl.dleu.net --emit-aliases docs/tag-aliases/xl.dleu.net.json --quiet
node tools/tag-audit.mjs https://xl.dleu.net --emit-aliases docs/tag-aliases/xl.dleu.net.plus-demo-drop.json --aliases-drop-demo --quiet
# 想连「语义近似候选」一起合并（如 心理干预 → 心理）：加 --aliases-include-review（建议先人工过一遍 notes）
```

生成逻辑只使用两类**可无条件判定**的信号：归一化后同名（大小写/全半角/空格差异）与「覆盖完全相同的文章集合（≥2 篇）」；语义近似默认不写进文件。
