export const dynamic = "force-dynamic";

const checks = [
  "Trusted Sites identity headers (presence only)",
  "D1 counter and R2 object persistence",
  "Stateless MCP 2026-07-28 JSON and request-scoped SSE",
  "Per-request Bearer authentication for Codex",
];

export default function Home() {
  return (
    <main>
      <section className="probe-card" aria-labelledby="probe-title">
        <p className="eyebrow">AND-37 · capability gate</p>
        <h1 id="probe-title">Mind Diary Sites probe</h1>
        <p className="warning">
          This is a non-product verification surface. It is not the Mind Diary
          service and does not prove a live deployment by itself.
        </p>
        <ul>
          {checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
        <p className="footnote">
          Responses are deliberately redacted: identity values, bearer secrets,
          private content, and queries are never returned by the probe.
        </p>
      </section>
    </main>
  );
}
