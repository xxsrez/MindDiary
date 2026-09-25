"use client";

import { useEffect, useState } from "react";

const PATH = "/api/v1/internal/operators/diagnostics/md485-object-reachability";

export default function Md485Diagnostic() {
  const [result, setResult] = useState("Reading authorized metadata…");
  useEffect(() => {
    let current = true;
    void fetch(PATH, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body: unknown = await response.json();
        return { status: response.status, body };
      })
      .then((value) => { if (current) setResult(JSON.stringify(value, null, 2)); })
      .catch(() => { if (current) setResult("Diagnostic read unavailable."); });
    return () => { current = false; };
  }, []);

  return (
    <main>
      <h1>MD-485 UAT diagnostic</h1>
      <pre aria-live="polite">{result}</pre>
    </main>
  );
}
