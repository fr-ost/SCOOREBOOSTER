// ScoreX license admin page: talks only to /api/admin on this site. The password stays in this tab (sessionStorage).
(() => {
  const $ = (id) => document.getElementById(id);
  const SS = "scx.admin";
  const get = () => { try { return sessionStorage.getItem(SS) || ""; } catch (_) { return ""; } };
  const put = (v) => { try { if (v) sessionStorage.setItem(SS, v); else sessionStorage.removeItem(SS); } catch (_) {} };
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : "-");
  const say = (el, text, kind) => { el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); };

  async function api(body) {
    const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + get() }, body: JSON.stringify(body) });
    let j = {};
    try { j = await res.json(); } catch (_) {}
    if (!res.ok || !j.ok) throw Object.assign(new Error(j.message || "Request failed (" + res.status + ")"), { status: res.status });
    return j;
  }

  function cell(text, cls) { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; }
  function btn(label, cls, onClick) { const b = document.createElement("button"); b.textContent = label; b.className = "small " + (cls || ""); b.addEventListener("click", onClick); return b; }

  async function act(action, k, question) {
    if (question && !confirm(question)) return;
    try { await api({ action, id: k.id }); say($("listMsg"), action === "reset" ? "Key reset: it can be activated on a new browser." : action === "revoke" ? "Key revoked." : "Key deleted.", "ok"); load(); }
    catch (e) { say($("listMsg"), e.message, "err"); }
  }

  async function load() {
    const rows = $("rows");
    try {
      const { keys } = await api({ action: "list" });
      rows.textContent = "";
      $("count2").textContent = "(" + keys.length + ")";
      if (!keys.length) { const tr = document.createElement("tr"); tr.appendChild(cell("No keys yet: create one above.", "muted")).colSpan = 7; rows.appendChild(tr); return; }
      for (const k of keys) {
        const tr = document.createElement("tr");
        tr.append(cell("…" + k.hint, "mono"), cell(k.note || "-"), cell(k.status, "st-" + k.status), cell(fmt(k.activatedAt)), cell(fmt(k.lastSeenAt)), cell(k.version || "-"));
        const td = document.createElement("td"); td.className = "actions";
        if (k.status !== "unused") td.append(btn("Reset", "", () => act("reset", k, "Reset this key? The browser using it stops at its next check, and the key can be activated on a new browser.")), " ");
        if (k.status !== "revoked") td.append(btn("Revoke", "danger", () => act("revoke", k, "Revoke this key? ScoreX stops on that browser at its next check.")), " ");
        td.append(btn("Delete", "danger", () => act("delete", k, "Delete this key for good?")));
        tr.appendChild(td);
        rows.appendChild(tr);
      }
    } catch (e) {
      if (e.status === 401) { put(""); show(false); say($("loginMsg"), "Wrong admin password", "err"); return; }
      say($("listMsg"), e.message, "err");
    }
  }

  function show(on) { $("login").hidden = on; $("panel").hidden = !on; if (on) load(); }

  $("loginBtn").addEventListener("click", async () => {
    put($("secret").value.trim());
    $("secret").value = "";
    say($("loginMsg"), "");
    try { await api({ action: "list" }); show(true); } catch (e) { put(""); say($("loginMsg"), e.message, "err"); }
  });
  $("secret").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
  $("logoutBtn").addEventListener("click", () => { put(""); show(false); });
  $("refreshBtn").addEventListener("click", () => load());
  $("createBtn").addEventListener("click", async () => {
    const b = $("createBtn"); b.disabled = true; say($("createMsg"), "");
    try {
      const { keys } = await api({ action: "create", count: Number($("count").value) || 1, note: $("note").value });
      $("newKeysText").value = keys.map((k) => k.key + (k.note ? "   (" + k.note + ")" : "")).join("\n");
      $("newKeysText").rows = Math.min(12, Math.max(2, keys.length));
      $("newKeys").hidden = false;
      say($("createMsg"), "Created " + keys.length + " key" + (keys.length === 1 ? "" : "s") + ".", "ok");
      load();
    } catch (e) { say($("createMsg"), e.message, "err"); }
    b.disabled = false;
  });
  $("copyBtn").addEventListener("click", async () => {
    const t = $("newKeysText"); t.select();
    try { await navigator.clipboard.writeText(t.value); say($("createMsg"), "Copied.", "ok"); } catch (_) { document.execCommand && document.execCommand("copy"); }
  });

  show(!!get());
})();
