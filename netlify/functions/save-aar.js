const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = "HymieZ";
const REPO_NAME = "hza-daily-aar";
const ENTRIES_PATH = "entries";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // GET = list recent entries
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    if (params.action === "list") {
      return await listEntries(headers);
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
  }

  // POST = save new entry
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const data = JSON.parse(event.body);
    const { date, mood, tasks, blockers, wins, tomorrow } = data;

    if (!date) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Date is required" }) };
    }

    // Calculate score
    let score = 0;
    (tasks || []).forEach((t) => {
      if (t.status === "Done") score += 1;
      else if (t.status === "Partial") score += 0.5;
    });

    // Build markdown
    let md = `# Daily AAR — ${date}\n\n`;
    md += `**Mood:** ${mood || "Not set"}\n`;
    md += `**Score:** ${score}/3\n\n`;
    md += `---\n\n`;
    md += `## Tasks\n\n`;
    md += `| # | Task | Why | Status |\n`;
    md += `|---|------|-----|--------|\n`;
    (tasks || []).forEach((t) => {
      const what = t.what || "(empty)";
      const why = t.why || "(empty)";
      md += `| ${t.num} | ${what} | ${why} | ${t.status} |\n`;
    });
    md += `\n`;
    if (blockers) md += `## Blockers\n\n${blockers}\n\n`;
    if (wins) md += `## Wins & Lessons\n\n${wins}\n\n`;
    if (tomorrow) md += `## Tomorrow's #1 Priority\n\n${tomorrow}\n`;

    // Also store a JSON sidecar for the history feature
    const meta = { date, mood: mood || "Not set", score, tasksCount: (tasks || []).length };

    // Commit the markdown file to GitHub
    const filename = `reflection-${date}.md`;
    const filepath = `${ENTRIES_PATH}/${filename}`;

    // Check if file already exists (to get SHA for update)
    let existingSha = null;
    try {
      const checkResp = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filepath}`);
      if (checkResp.ok) {
        const existing = await checkResp.json();
        existingSha = existing.sha;
      }
    } catch (e) {
      // File doesn't exist yet, that's fine
    }

    // Commit the file
    const commitBody = {
      message: `AAR ${date} — ${mood || "No mood"} — ${score}/3`,
      content: Buffer.from(md).toString("base64"),
    };
    if (existingSha) commitBody.sha = existingSha;

    const commitResp = await ghFetch(
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filepath}`,
      { method: "PUT", body: JSON.stringify(commitBody) }
    );

    if (!commitResp.ok) {
      const errData = await commitResp.text();
      console.error("GitHub commit failed:", errData);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "GitHub commit failed", detail: errData }) };
    }

    // Also update the index.json for history
    await updateIndex(meta);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, file: filepath, score, date }),
    };
  } catch (e) {
    console.error("Error:", e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

async function listEntries(headers) {
  try {
    const resp = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${ENTRIES_PATH}/index.json`);
    if (!resp.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ entries: [] }) };
    }
    const data = await resp.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const entries = JSON.parse(content);
    // Sort by date descending
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return { statusCode: 200, headers, body: JSON.stringify({ entries }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ entries: [] }) };
  }
}

async function updateIndex(newEntry) {
  const indexPath = `${ENTRIES_PATH}/index.json`;
  let entries = [];
  let existingSha = null;

  try {
    const resp = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${indexPath}`);
    if (resp.ok) {
      const data = await resp.json();
      existingSha = data.sha;
      entries = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
    }
  } catch (e) {
    // Index doesn't exist yet
  }

  // Upsert: replace existing entry for same date, or add new
  const idx = entries.findIndex((e) => e.date === newEntry.date);
  if (idx >= 0) {
    entries[idx] = newEntry;
  } else {
    entries.push(newEntry);
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));

  const commitBody = {
    message: `Update AAR index — ${newEntry.date}`,
    content: Buffer.from(JSON.stringify(entries, null, 2)).toString("base64"),
  };
  if (existingSha) commitBody.sha = existingSha;

  await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${indexPath}`, {
    method: "PUT",
    body: JSON.stringify(commitBody),
  });
}

async function ghFetch(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const defaultHeaders = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "hza-daily-aar",
  };
  return fetch(url, {
    ...options,
    headers: { ...defaultHeaders, ...(options.headers || {}) },
  });
}
