// Runs the timeline script in index.html against a do-nothing gsap and prints the sound cues it places, so audio and picture share one source of timing.
import { readFileSync } from "node:fs"
const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain })
globalThis.gsap = chain
globalThis.window = {}
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
new Function(html.match(/<script id="film-timeline">([\s\S]*?)<\/script>/)[1])()
console.log(JSON.stringify(window.__cues.sort((a, b) => a[0] - b[0])))
