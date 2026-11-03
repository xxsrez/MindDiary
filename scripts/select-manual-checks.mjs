import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Read-only catalog discovery. This command never executes a test or writes a plan.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "docs/operations/manual-acceptance");
const topics = JSON.parse(readFileSync(resolve(directory, "topics.json"), "utf8"));
function catalog() {
  const ids = new Set();
  return readdirSync(directory, { recursive: true })
    .filter(file => file.endsWith(".md") && /^\d/.test(file))
    .flatMap(file => {
      const text = readFileSync(resolve(directory, file), "utf8");
      const heading = text.match(/^# ([A-Z]+-\d+) — (.+)$/m);
      if (!heading) return [];
      const front = text.match(/^---\n([\s\S]*?)\n---\n/);
      if (!front) throw Error("Missing frontmatter: " + file);
      const fields = {};
      for (const line of front[1].split("\n")) {
        const match = line.match(/^([a-z_]+): (.*)$/);
        if (!match || Object.hasOwn(fields, match[1])) throw Error("Invalid metadata: " + file);
        const value = match[2];
        fields[match[1]] = /^[["]/.test(value) ? JSON.parse(value) : value;
      }
      const id = heading[1];
      if (ids.has(id)) throw Error("Duplicate ID: " + id);
      ids.add(id);
      if (!Array.isArray(fields.topics) || fields.topics.some(t => !Object.hasOwn(topics, t)))
        throw Error("Unknown/missing topics: " + id);
      if (fields.uat && !["always", "when-changed", "extended"].includes(fields.uat))
        throw Error("Unknown uat: " + id);
      if (fields.uat && fields.uat !== "always" && !fields.uat_when)
        throw Error("Missing uat_when: " + id);
      if (fields.clients && (!Array.isArray(fields.clients) ||
          fields.clients.some(c => !["chatgpt", "codex"].includes(c))))
        throw Error("Unknown clients: " + id);
      return [{ id, title: heading[2], ...fields, path: relative(root, resolve(directory, file)), text }];
    }).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}
try {
  const args = process.argv.slice(2);
  const options = { mode: "uat", topics: [], ids: [], clients: [] };
  const flags = new Set(["--json", "--list-topics", "--validate", "--help"]);
  const values = new Set(["--mode", "--topics", "--ids", "--clients", "--search"]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flags.has(key)) options[key.slice(2)] = true;
    else if (values.has(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw Error("Missing value for " + key);
      options[key.slice(2)] = ["--topics", "--ids", "--clients"].includes(key) ? value.split(",") : value;
    } else throw Error("Unknown option: " + key);
  }
  if (options.help) {
    console.log("node scripts/select-manual-checks.mjs --list-topics\n" +
      "  --mode uat|deep --topics import_resume,concurrency --clients chatgpt,codex\n" +
      "  --ids REG-01 --search автобусы --json\n" +
      "  --validate\nRead-only selection; no tests run. Without --clients both integrations remain eligible.");
    process.exit(0);
  }
  if (!["uat", "deep"].includes(options.mode)) throw Error("Unknown mode");
  for (const topic of options.topics) if (!Object.hasOwn(topics, topic)) throw Error("Unknown topic: " + topic);
  for (const client of options.clients) if (!["chatgpt", "codex"].includes(client)) throw Error("Unknown client: " + client);
  const all = catalog();
  for (const id of options.ids) if (!all.some(c => c.id === id)) throw Error("Unknown ID: " + id);
  if (options["validate"]) {
    console.log(JSON.stringify({ status: "valid", cases: all.length, topics: Object.keys(topics).length }));
    process.exit(0);
  }
  if (options["list-topics"]) {
    console.log(options.json ? JSON.stringify(topics) : Object.entries(topics).map(([k,v]) => k + "\t" + v).join("\n"));
    process.exit(0);
  }
  const hasFilter = options.topics.length || options.ids.length || options.search;
  if (options.mode === "uat" && !hasFilter) throw Error("Specify --topics, --ids or --search; a baseline-only UAT plan is not enough.");
  const selected = [];
  for (const item of all) {
    const explicit = options.ids.includes(item.id);
    if (options.clients.length && item.clients && !item.clients.some(c => options.clients.includes(c))) {
      if (explicit) throw Error("ID conflicts with --clients: " + item.id);
      continue;
    }
    const reasons = [];
    if (options.mode === "uat" && item.uat === "always") reasons.push("каждый product cut");
    if (explicit) reasons.push("явно выбран ID");
    for (const topic of options.topics) if (item.topics.includes(topic) && (options.mode === "deep" || item.uat))
      reasons.push(topic + ": " + topics[topic]);
    if (options.search && item.text.toLowerCase().includes(options.search.toLowerCase()) && (options.mode === "deep" || item.uat))
      reasons.push("текст: " + options.search);
    if (options.mode === "deep" && !hasFilter) reasons.push("полный глубокий каталог");
    if (reasons.length) {
      const { text, ...safe } = item;
      selected.push({ ...safe, reasons });
    }
  }
  if (!selected.some(c => c.uat !== "always")) throw Error("No scenario matched; do not treat baseline alone as adequate coverage.");
  const result = { mode: options.mode, execution: "not-run", selection: "candidates-requiring-impact-review",
    count: selected.length, cases: selected };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("Кандидаты для ручного плана; ничего не запущено. Проверить применимость по diff и acceptance.");
    for (const c of selected) console.log(c.id + " [" + (c.uat ?? "deep-only") + "] " + c.title + "\n  " + c.path + "\n  " + c.reasons.join("; "));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
