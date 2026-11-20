// Shared staff login for the officer dashboard and the Staff & security page.
// The session token lives in sessionStorage: it is forgotten when the browser tab closes.
const StaffAuth = (() => {
  const KEY = "agriconnect.staffToken";
  const get = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
  const set = (t) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch {} };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Call the API as the signed-in staff member. Throws an Error with .login = true when a login is needed. */
  async function api(base, method, path, body) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    const token = get();
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/staff/login") {
      set(null);
      throw Object.assign(new Error("Please log in"), { login: true });
    }
    if (res.status === 403 && data.setup_2fa && !location.pathname.endsWith("staff.html")) {
      location.href = "staff.html#security";
    }
    if (!res.ok) throw Object.assign(new Error(data.details ? data.details.join("; ") : data.error || "Request failed"), { status: res.status, data });
    return data;
  }

  /** Draw a login form in `el`. Calls onDone(staff) after a successful login. */
  function loginForm(el, base, onDone) {
    el.innerHTML = `
      <form class="login-form" style="display:flex;flex-direction:column;gap:10px;max-width:360px">
        <label class="field">Email<input type="email" name="email" autocomplete="username" required></label>
        <label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label>
        <label class="field code" style="display:none">6-digit code from your authenticator app<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
        <p class="login-error" style="color:var(--red);font-weight:700;margin:0"></p>
        <button class="btn">Log in</button>
      </form>`;
    const form = el.querySelector("form");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const err = form.querySelector(".login-error");
      err.textContent = "";
      try {
        const r = await api(base, "POST", "/api/staff/login", { email: fd.get("email"), password: fd.get("password"), code: fd.get("code") || undefined });
        set(r.token);
        if (r.needs_2fa_setup) { location.href = "staff.html#security"; return; }
        onDone(r.staff);
      } catch (ex) {
        if (ex.data?.needs_code) {
          form.querySelector(".code").style.display = "";
          form.querySelector("[name=code]").focus();
          err.textContent = form.querySelector("[name=code]").value ? ex.message : "";
        } else err.textContent = ex.message;
      }
    };
  }

  async function logout(base) {
    try { await api(base, "POST", "/api/staff/logout", {}); } catch {}
    set(null);
  }

  return { get, set, api, loginForm, logout, esc };
})();
