import assert from "node:assert/strict"
import { test } from "node:test"
import { decode, formatResults, page, title, toText } from "../home/.pi/agent/extensions/web/html.ts"

test("entities decode once, numeric and named", () => {
  assert.equal(decode("a &amp;lt; b &#x41;&#66; &nbsp;&hellip; &bogus;"), "a &lt; b AB  … &bogus;")
})

test("scripts, styles and the head are dropped; headings, links and lists kept", () => {
  const html = `<html><head><title>T &amp; U</title><style>p{}</style></head><body>
    <script>alert(1)</script><h2>Install <b>it</b></h2>
    <p>See <a href="/docs?a=1&amp;b=2">the docs</a> and <a href="#top">top</a>.</p>
    <ul><li>one</li><li><p>two</p></li></ul><h3>Note<a class="headerlink" href="#note">¶</a></h3></body></html>`
  assert.equal(title(html), "T & U")
  assert.equal(toText(html, "https://example.org/x/"), "## Install it\n\nSee [the docs](https://example.org/docs?a=1&b=2) and top.\n\n- one\n- two\n\n### Note")
})

test("main content wins over navigation, and code keeps its spacing", () => {
  const html = `<nav><a href="/a">Home</a></nav><main><p>Body &lt;x&gt;</p><pre><code>fn  main() {
    x &amp;&amp; y
}</code></pre></main><footer>f</footer>`
  assert.equal(toText(html), "Body <x>\n\n```\nfn  main() {\n    x && y\n}\n```")
})

test("a table row stays on one line, whatever its cells hold", () => {
  assert.equal(toText("<table><tr><th>Key</th>\n<th>Flag</th></tr>\n<tr><td><p>Memory=20g</p></td>\n<td><p><code>--memory 20g</code></p></td></tr></table>"), "| Key | Flag |\n| Memory=20g | `--memory 20g` |")
})

test("page windows a long text and says where to read on", () => {
  assert.deepEqual(page("abcdef", 0, 4), { text: "abcd", next: 4 })
  assert.deepEqual(page("abcdef", 4, 4), { text: "ef" })
})

test("results list title, date, URL and snippet", () => {
  const out = formatResults(
    [
      { title: "A", url: "https://a", content: " one\n two ", publishedDate: "2026-01-02T00:00:00" },
      { title: "B", url: "https://b" },
    ],
    1,
  )
  assert.equal(out, "1. A (2026-01-02)\n   https://a\n   one two")
  assert.equal(formatResults([], 5), "No results.")
})

test("results without an http(s) host are left out and counted", () => {
  const out = formatResults([{ title: "A", url: "http:///go/v1/x" }, { title: "B", url: "https://b" }, { title: "C", url: "javascript:x" }], 5)
  assert.equal(out, "1. B\n   https://b\n\n2 results without a usable URL left out.")
})
