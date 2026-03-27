// ============================================================
// BizManager — Cloudflare Worker (Single File) - FIXED VERSION
// Deploy via Cloudflare Worker Web Editor
// KV Namespace binding: DATA_STORE
// ============================================================

const PIN = "1234";
const MASTER_KEY = "4321";
const LICENSE_EXPIRE = "2026-12-31";
const USE_KV_LICENSE = true;

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return new Response(
        `<html><body style="font-family:sans-serif;padding:24px"><h2>Error</h2><pre>${escapeHtml(
          err?.stack || err?.toString?.() || "Unknown error"
        )}</pre></body></html>`,
        { headers: { "content-type": "text/html;charset=UTF-8" } }
      );
    }
  }
};

// ============================================================
// MAIN ROUTER
// ============================================================
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const cookie = request.headers.get("Cookie") || "";
  const loggedIn = cookie.includes("auth=1");

  const masterAccess = url.searchParams.get("master") === MASTER_KEY;

  if (!masterAccess) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > LICENSE_EXPIRE) return html(expiredPage());
    if (USE_KV_LICENSE && env.DATA_STORE) {
      const kvLicense = await env.DATA_STORE.get("APP_LICENSE");
      if (kvLicense && today > kvLicense) return html(expiredPage());
    }
  }

  if (path === "/login" && method === "POST") {
    const form = await request.formData();
    if (form.get("pin") === PIN) {
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": "auth=1; Path=/; HttpOnly; SameSite=Strict",
          Location: "/"
        }
      });
    }
    return html(loginPage("Wrong PIN ❌"));
  }

  if (path === "/logout") {
    return new Response(null, {
      status: 302,
      headers: {
        "Set-Cookie": "auth=; Path=/; HttpOnly; Max-Age=0",
        Location: "/login"
      }
    });
  }

  if (!loggedIn && path !== "/login") return html(loginPage(""));

  // ---------------- API ----------------
  if (path === "/api/license-info") {
    const kv = env.DATA_STORE ? await env.DATA_STORE.get("APP_LICENSE") : null;
    const expiry = kv || LICENSE_EXPIRE;
    const days = Math.floor((new Date(expiry).getTime() - Date.now()) / 86400000);
    return Response.json({ expiry, days, status: days < 0 ? "Expired" : "Active" });
  }

  if (path === "/api/set-license" && method === "POST") {
    if (!masterAccess) return Response.json({ success: false, error: "Unauthorized" }, { status: 403 });
    const d = await request.json();
    if (!env.DATA_STORE) return Response.json({ success: false, error: "KV not configured" }, { status: 500 });
    await env.DATA_STORE.put("APP_LICENSE", String(d?.date || ""));
    return Response.json({ success: true });
  }

  if (path === "/api/list" && method === "POST") {
    const body = await request.json();
    return Response.json(await kvList(env, body?.prefix || ""));
  }

  if (path === "/api/save" && method === "POST") {
    if (!env.DATA_STORE) return Response.json({ success: false, error: "KV not configured" }, { status: 500 });
    const body = await request.json();
    const prefix = body?.prefix || "";
    const id = body?.id;
    const keyFromBody = body?.key;
    const data = body?.data || {};

    let key = keyFromBody;
    if (!key) {
      if (id) key = id.startsWith(prefix) ? id : prefix + id;
      else key = prefix + genId();
    }

    await env.DATA_STORE.put(key, JSON.stringify(data));
    return Response.json({ success: true, key });
  }

  if (path === "/api/get" && method === "POST") {
    if (!env.DATA_STORE) return Response.json(null);
    const { key } = await request.json();
    const val = await env.DATA_STORE.get(key);
    return Response.json(val ? JSON.parse(val) : null);
  }

  if (path === "/api/delete" && method === "POST") {
    if (!env.DATA_STORE) return Response.json({ success: false, error: "KV not configured" }, { status: 500 });
    const { key } = await request.json();
    if (!key) return Response.json({ success: false, error: "Key is required" }, { status: 400 });
    await env.DATA_STORE.delete(key);
    return Response.json({ success: true });
  }

  // ---------------- PAGES ----------------
  if (path === "/") return html(layout(dashboardPage(), "dashboard"));
  if (path === "/inventory") return html(layout(inventoryPage(), "inventory"));
  if (path === "/parties") return html(layout(partiesPage(), "parties"));
  if (path === "/purchases") return html(layout(purchasesPage(), "purchases"));
  if (path === "/sales") return html(layout(salesPage(), "sales"));
  if (path === "/payments") return html(layout(paymentsPage(), "payments"));
  if (path === "/expenses") return html(layout(expensesPage(), "expenses"));
  if (path === "/ledger") return html(layout(ledgerPage(), "ledger"));
  if (path === "/profit-loss") return html(layout(profitLossPage(), "profitloss"));
  if (path === "/day-details") return html(layout(dayDetailsPage(), "daydetails"));
  if (path === "/admin") return html(layout(adminPage(), "admin"));

  return html(layout(`<div class="empty">Page not found</div>`, ""));
}

// ============================================================
// HELPERS
// ============================================================
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function kvList(env, prefix) {
  if (!env.DATA_STORE) return [];

  let cursor;
  const keys = [];
  do {
    const page = await env.DATA_STORE.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const values = await Promise.all(keys.map((k) => env.DATA_STORE.get(k)));
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const value = values[i];
    if (!value) continue;
    try {
      out.push({ _key: keys[i], ...JSON.parse(value) });
    } catch {
      // skip invalid JSON entries
    }
  }
  return out;
}

function html(content) {
  return new Response(content, {
    headers: { "content-type": "text/html;charset=UTF-8" }
  });
}

// ============================================================
// STYLES
// ============================================================
function getCSS() {
  return `<style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#f4f6f9;--card:#ffffff;--text:#1a1d23;--muted:#6b7280;
      --primary:#2563eb;--primary-fg:#fff;--accent:#059669;
      --danger:#dc2626;--warning:#d97706;--border:#e2e5ea;
      --sidebar-bg:#1e2330;--sidebar-fg:#94a3b8;--sidebar-active:#2563eb;
      --radius:10px;--shadow:0 1px 3px rgba(0,0,0,.08)
    }
    body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.5;font-size:14px}
    a{color:var(--primary);text-decoration:none}

    .app{display:flex;min-height:100vh}
    .sidebar{width:230px;background:var(--sidebar-bg);color:var(--sidebar-fg);position:fixed;left:0;top:0;height:100vh;overflow:auto;z-index:50;transition:transform .25s}
    .sidebar .logo{padding:20px 16px;font-size:18px;font-weight:700;color:#fff;border-bottom:1px solid rgba(255,255,255,.08)}
    .sidebar nav{padding:12px 8px}
    .sidebar nav a{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;color:var(--sidebar-fg);font-size:13px;font-weight:500;margin-bottom:2px}
    .sidebar nav a:hover{background:rgba(255,255,255,.06);color:#e2e8f0}
    .sidebar nav a.active{background:var(--sidebar-active);color:#fff}
    .main{margin-left:230px;flex:1;padding:24px 32px;min-height:100vh}

    .mobile-header{display:none;position:fixed;top:0;left:0;right:0;height:56px;background:var(--card);border-bottom:1px solid var(--border);z-index:40;padding:0 16px;align-items:center}
    .hamburger{background:none;border:none;font-size:24px;cursor:pointer;color:var(--text)}
    .overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:45}
    @media(max-width:860px){
      .sidebar{transform:translateX(-100%)}
      .sidebar.open{transform:translateX(0)}
      .overlay.open{display:block}
      .mobile-header{display:flex}
      .main{margin-left:0;padding:72px 16px 24px}
    }

    .page-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:20px}
    .page-title{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:4px}
    .page-sub{font-size:13px;color:var(--muted)}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}

    .stats,.summary-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:18px}
    .stat,.summary-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
    .stat .label,.summary-card .label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;margin-bottom:4px}
    .stat .value,.summary-card .value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}

    .tbl{width:100%;border-collapse:collapse;font-size:13px}
    .tbl th{text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);background:rgba(0,0,0,.015)}
    .tbl td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
    .tbl tr:hover td{background:rgba(37,99,235,.02)}
    .tbl .r{text-align:right;font-variant-numeric:tabular-nums}
    .tbl .bold{font-weight:600}

    .table-wrap{overflow:auto;-webkit-overflow-scrolling:touch}
    .search-wrap{position:relative;max-width:340px;margin-bottom:16px}
    .search-wrap input{padding-left:34px}
    .search-wrap .icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted)}

    input,select,textarea{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--card);color:var(--text);outline:none;transition:border .15s}
    input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.1)}
    label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px}
    .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
    .form-group{margin-bottom:12px}
    @media(max-width:560px){.form-row{grid-template-columns:1fr}}

    .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}
    .btn:active{transform:scale(.98)}
    .btn-primary{background:var(--primary);color:var(--primary-fg)}
    .btn-primary:hover{background:#1d4ed8}
    .btn-success{background:var(--accent);color:#fff}
    .btn-success:hover{background:#047857}
    .btn-danger{background:var(--danger);color:#fff}
    .btn-danger:hover{background:#b91c1c}
    .btn-outline{background:transparent;color:var(--text);border:1px solid var(--border)}
    .btn-outline:hover{background:var(--bg)}
    .btn-sm{padding:6px 10px;font-size:12px}

    .tabs{display:flex;gap:4px;background:var(--bg);border-radius:8px;padding:4px;margin-bottom:16px;width:fit-content}
    .tab{padding:8px 14px;border:none;border-radius:6px;background:transparent;color:var(--muted);font-size:13px;font-weight:500;cursor:pointer}
    .tab.active{background:var(--card);color:var(--text);box-shadow:var(--shadow)}

    .badge{display:inline-flex;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
    .badge-cash{background:rgba(5,150,105,.1);color:var(--accent)}
    .badge-bank{background:rgba(37,99,235,.1);color:var(--primary)}

    .text-danger{color:var(--danger)}
    .text-success{color:var(--accent)}
    .text-warning{color:var(--warning)}
    .text-muted{color:var(--muted)}
    .empty{text-align:center;padding:36px 16px;color:var(--muted)}

    .method-toggle{display:flex;gap:8px}
    .method-btn{flex:1;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--card);cursor:pointer;font-size:13px;font-weight:500;text-align:center;color:var(--muted)}
    .method-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}

    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;align-items:center;justify-content:center;padding:12px}
    .modal-overlay.open{display:flex}
    .modal{background:var(--card);border-radius:12px;padding:22px;width:100%;max-width:700px;max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)}
    .modal h3{font-size:17px;font-weight:700;margin-bottom:16px}

    .clickable{cursor:pointer;color:var(--primary);font-weight:600}
    .clickable:hover{text-decoration:underline}

    .invoice-paper{max-width:760px;margin:0 auto;background:#fff;border:1px solid var(--border);border-radius:10px;padding:18px}
    .invoice-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}

    .pl-header{padding:16px 20px;border-bottom:1px solid var(--border)}
    .pl-row{display:flex;justify-content:space-between;gap:12px;padding:7px 20px}
    .pl-row.total{font-weight:700;background:rgba(0,0,0,.02)}
    .pl-row strong{font-size:15px}

    .login-page{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e2330 0%,#2a3042 100%)}
    .login-card{background:var(--card);border-radius:16px;padding:40px 32px;width:90%;max-width:360px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.2)}
    .login-card h2{font-size:20px;font-weight:700;margin:16px 0 4px}
    .login-card .sub{color:var(--muted);font-size:13px;margin-bottom:24px}
    .login-card input{margin-bottom:16px;text-align:center;font-size:20px;letter-spacing:8px}
    .login-card .btn{width:100%}
    .login-card .err{color:var(--danger);font-size:13px;margin-bottom:12px}

    .hidden{display:none !important}
  </style>`;
}

// ============================================================
// LAYOUT — Global JS only contains truly global utilities
// Page-specific functions live in each page's own <script>
// ============================================================
function layout(content, active) {
  const nav = [
    { path: "/", icon: "📊", label: "Dashboard", id: "dashboard" },
    { path: "/inventory", icon: "📦", label: "Inventory", id: "inventory" },
    { path: "/parties", icon: "👥", label: "Customers & Suppliers", id: "parties" },
    { path: "/purchases", icon: "🛒", label: "Purchases", id: "purchases" },
    { path: "/sales", icon: "🚚", label: "Sales", id: "sales" },
    { path: "/payments", icon: "💳", label: "Receipts & Payments", id: "payments" },
    { path: "/expenses", icon: "💰", label: "Expenses", id: "expenses" },
    { path: "/ledger", icon: "📖", label: "Ledger", id: "ledger" },
    { path: "/profit-loss", icon: "📈", label: "Profit & Loss", id: "profitloss" },
    { path: "/day-details", icon: "🗓️", label: "Day Details", id: "daydetails" },
    { path: "/admin", icon: "⚙️", label: "Admin", id: "admin" }
  ];

  const navHTML = nav
    .map((n) => `<a href="${n.path}" class="${active === n.id ? "active" : ""}">${n.icon} ${n.label}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>BizManager</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  ${getCSS()}
  <script>
  // ============================================================
  // GLOBAL UTILITIES — defined in <head> so they are available
  // before any page <script> or onclick handler fires
  // ============================================================
// ---------- INVENTORY GLOBAL FIX ----------

// ---------- GLOBAL SAVE PRODUCT ----------
window.saveProduct = async function () {
  try {
    console.log('✅ saveProduct triggered');

    var name = document.getElementById('pName')?.value?.trim();
    if (!name) {
      alert('❌ Enter product name');
      return;
    }

    var skuEl = document.getElementById('pSku');
    var sku = skuEl.value.trim() || ('PRD-' + Math.random().toString(36).slice(2,6).toUpperCase());
    skuEl.value = sku;

    var data = {
      name: name,
      sku: sku,
      unit: document.getElementById('pUnit')?.value || 'pcs',
      purchasePrice: +document.getElementById('pBuy')?.value || 0,
      salePrice: +document.getElementById('pSell')?.value || 0,
      stock: +document.getElementById('pStock')?.value || 0
    };

    console.log('Saving:', data);

var editKey = document.getElementById('editProductKey')?.value;

let res;

if (editKey) {
  res = await saveByKey(editKey, data);
} else {
  res = await saveItem('product:', data);
}
    console.log('Response:', res);

    if (!res || !res.key) {
      alert('❌ Save failed');
      return;
    }

    alert('✅ Product saved');

    closeModal('addProduct');

    // reload table safely
    if (typeof loadProducts === 'function') {
      await loadProducts();
    } else {
      location.reload();
    }

  } catch (err) {
    console.error(err);
    alert('❌ Error: ' + err.message);
  }
};

window.openAddProduct = function () {
  var modal = document.getElementById('addProduct');

  if (!modal) {
    alert('❌ Product modal not found');
    return;
  }

  // reset form safely
  var set = (id, val) => {
    var el = document.getElementById(id);
    if (el) el.value = val;
  };

  set('editProductKey', '');
  set('pName', '');
  set('pSku', '');
  set('pUnit', 'pcs');
  set('pBuy', '');
  set('pSell', '');
  set('pStock', '');

  var dup = document.getElementById('productDuplicate');
  if (dup) dup.textContent = '';

  var title = document.getElementById('productModalTitle');
  if (title) title.textContent = 'Add Product';

  modal.classList.add('open');
};

  window.api = async function(path, body) {
    try {
      var response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      var data = await response.json();
      if (!response.ok || (data && data.success === false)) {
        alert('Error: ' + (data.error || response.status));
        throw new Error(data.error || 'Request failed');
      }
      return data;
    } catch (err) {
      if (!err.message.includes('Error:')) alert('Network Error: ' + err.message);
      throw err;
    }
  };

  window.loadList = async function(prefix) {
    return api('/api/list', { prefix: prefix });
  };

  window.saveItem = async function(prefix, data, id) {
    var res = await api('/api/save', { prefix: prefix, data: data, id: id });
    if (!res || !res.key) { alert('Save failed'); return null; }
    return res;
  };

  window.saveByKey = async function(key, data) {
    return api('/api/save', { key: key, data: data });
  };

  window.deleteItem = async function(key, ask) {
    if (ask !== false && !confirm('Delete this item?')) return;
    await api('/api/delete', { key: key });
  };

  window.openModal = function(id) {
    var el = document.getElementById(id);
    if (!el) { alert('Modal not found: ' + id); return; }
    el.classList.add('open');
  };

  window.closeModal = function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  };

  window.fmt = function(n) {
    return Number(n || 0).toLocaleString();
  };

  window.todayISO = function() {
    return new Date().toISOString().slice(0, 10);
  };

  window.cleanForSave = function(obj) {
    var c = Object.assign({}, obj);
    delete c._key;
    return c;
  };

  window.normalize = function(v) {
    return String(v || '').trim().toLowerCase();
  };

  window.txnNo = function(prefix) {
    var d = todayISO().replace(/-/g, '');
    return prefix + '-' + d + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  };

  window.setMethod = function(el, value, hiddenId, groupSelector) {
    var hidden = document.getElementById(hiddenId);
    if (hidden) hidden.value = value;
    document.querySelectorAll(groupSelector).forEach(function(x) { x.classList.remove('active'); });
    if (el) el.classList.add('active');
  };

  window.toggleSidebar = function() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('open');
  };
  </script>
</head>
<body>
  <div class="mobile-header">
    <button class="hamburger" onclick="toggleSidebar()">☰</button>
    <span style="font-weight:700;margin-left:12px">BizManager</span>
  </div>
  <div class="overlay" id="overlay" onclick="toggleSidebar()"></div>

  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="logo">📦 BizManager</div>
      <nav>
        ${navHTML}
        <a href="/logout" style="margin-top:20px;opacity:.65">🚪 Logout</a>
      </nav>
    </aside>
    <main class="main">${content}</main>
  </div>

  <script>
  // close sidebar on nav click
  document.querySelectorAll('.sidebar nav a').forEach(function(a) {
    a.addEventListener('click', function() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('overlay').classList.remove('open');
    });
  });
  </script>
</body>
</html>`;
}

// ============================================================
// LOGIN/EXPIRED
// ============================================================
function loginPage(msg) {
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizManager Login</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
${getCSS()}
</head>
<body>
  <div class="login-page">
    <form class="login-card" method="POST" action="/login">
      <div style="font-size:40px">📦</div>
      <h2>BizManager</h2>
      <div class="sub">Enter PIN to continue</div>
      ${msg ? `<div class="err">${msg}</div>` : ""}
      <input type="password" name="pin" placeholder="••••" maxlength="6" autofocus required>
      <button type="submit" class="btn btn-primary">Login</button>
    </form>
  </div>
</body></html>`;
}

function expiredPage() {
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>License Expired</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
${getCSS()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div style="font-size:40px">⚠️</div>
      <h2>License Expired</h2>
      <div class="sub">Please renew your license to continue.</div>
    </div>
  </div>
</body></html>`;
}

// ============================================================
// DASHBOARD
// ============================================================
function dashboardPage() {
  return `
  <div class="page-header">
    <div>
      <div class="page-title">Dashboard</div>
      <div class="page-sub">Overview of your business performance</div>
    </div>
  </div>
  <div class="stats" id="stats"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div class="card">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">Recent Sales</h3>
      <div id="recentSales" class="table-wrap"></div>
    </div>
    <div class="card">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">Recent Purchases</h3>
      <div id="recentPurchases" class="table-wrap"></div>
    </div>
  </div>
  <script>
  (async function() {
    var data = await Promise.all([
      loadList('product:'), loadList('sale:'), loadList('purchase:'),
      loadList('payment:'), loadList('expense:'), loadList('party:')
    ]);
    var products=data[0], sales=data[1], purchases=data[2], payments=data[3], expenses=data[4], parties=data[5];
    var customers=parties.filter(function(p){return p.type==='customer';});
    var suppliers=parties.filter(function(p){return p.type==='supplier';});
    var totalSales=sales.reduce(function(s,x){return s+(x.total||0);},0);
    var totalPurchases=purchases.reduce(function(s,x){return s+(x.total||0);},0);
    var totalExpenses=expenses.reduce(function(s,x){return s+(x.amount||0);},0);
    var receivables=customers.reduce(function(s,c){return s+Math.max(0,c.balance||0);},0);
    var payables=suppliers.reduce(function(s,c){return s+Math.max(0,c.balance||0);},0);
    var cashFlow=payments.reduce(function(sum,p){return p.type==='receipt'?sum+(p.amount||0):sum-(p.amount||0);},0);
    var cardData=[
      {label:'Total Sales',value:fmt(totalSales),color:'var(--accent)'},
      {label:'Total Purchases',value:fmt(totalPurchases),color:'var(--primary)'},
      {label:'Total Expenses',value:fmt(totalExpenses),color:'var(--warning)'},
      {label:'Receivables',value:fmt(receivables),color:'var(--accent)'},
      {label:'Payables',value:fmt(payables),color:'var(--danger)'},
      {label:'Cash Flow',value:fmt(cashFlow),color:cashFlow>=0?'var(--accent)':'var(--danger)'},
      {label:'Products',value:products.length,color:'var(--primary)'},
      {label:'Customers',value:customers.length,color:'var(--accent)'}
    ];
    document.getElementById('stats').innerHTML=cardData.map(function(s){
      return '<div class="stat"><div class="label">'+s.label+'</div><div class="value" style="color:'+s.color+'">'+s.value+'</div></div>';
    }).join('');
    var rSales=sales.slice().sort(function(a,b){return (b.date||'').localeCompare(a.date||'');}).slice(0,5);
    var rPurchases=purchases.slice().sort(function(a,b){return (b.date||'').localeCompare(a.date||'');}).slice(0,5);
    document.getElementById('recentSales').innerHTML=rSales.length
      ?'<table class="tbl"><tr><th>Date</th><th>Invoice</th><th>Customer</th><th class="r">Total</th></tr>'+rSales.map(function(s){return '<tr><td>'+(s.date||'')+'</td><td>'+(s.invoiceNo||'')+'</td><td>'+(s.customerName||'')+'</td><td class="r bold">'+fmt(s.total)+'</td></tr>';}).join('')+'</table>'
      :'<div class="empty">No sales yet</div>';
    document.getElementById('recentPurchases').innerHTML=rPurchases.length
      ?'<table class="tbl"><tr><th>Date</th><th>Purchase #</th><th>Supplier</th><th class="r">Total</th></tr>'+rPurchases.map(function(p){return '<tr><td>'+(p.date||'')+'</td><td>'+(p.purchaseNo||'')+'</td><td>'+(p.supplierName||'')+'</td><td class="r bold">'+fmt(p.total)+'</td></tr>';}).join('')+'</table>'
      :'<div class="empty">No purchases yet</div>';
  })();
  </script>`;
}

// ============================================================
// INVENTORY
// ============================================================
function inventoryPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Inventory</div><div class="page-sub">Manage products, SKU and stock</div></div>
    <button class="btn btn-primary" onclick="openAddProduct()">➕ Add Product</button>
  </div>
  <div class="search-wrap">
    <span class="icon">🔍</span>
    <input placeholder="Search products..." oninput="filterProducts(this.value)">
  </div>
  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>Name</th><th>SKU</th><th class="r">Purchase</th><th class="r">Sale</th><th class="r">Stock</th><th class="r">Actions</th></tr></thead>
        <tbody id="productBody"></tbody>
      </table>
    </div>
  </div>

  <div class="modal-overlay" id="addProduct"><div class="modal">
    <h3 id="productModalTitle">Add Product</h3>
    <input type="hidden" id="editProductKey">
    <div class="form-group">
      <label>Product Name</label>
      <input id="pName" placeholder="Product name" oninput="syncSkuAndDuplicate()">
      <div id="productDuplicate" class="text-warning" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div class="form-row">
      <div><label>SKU</label><input id="pSku" placeholder="Auto generated"></div>
      <div><label>Unit</label><input id="pUnit" value="pcs" placeholder="pcs, kg..."></div>
    </div>
    <div class="form-row">
      <div><label>Purchase Price</label><input type="number" id="pBuy" placeholder="0"></div>
      <div><label>Sale Price</label><input type="number" id="pSell" placeholder="0"></div>
    </div>
    <div class="form-group"><label>Opening Stock</label><input type="number" id="pStock" placeholder="0"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeModal('addProduct')">Cancel</button>
      <button class="btn btn-primary" onclick="saveProduct()">Save</button>
    </div>
  </div></div>

  <script>
  var allProducts = [];

  function autoSku(name) {
    var cleaned = String(name||'').replace(/[^a-zA-Z0-9]/g,'').toUpperCase().slice(0,4)||'PRD';
    return cleaned+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
  }

  function findProductDuplicate(name, editKey) {
    var n = normalize(name);
    return allProducts.find(function(p){ return normalize(p.name)===n && p._key!==editKey; });
  }

  window.syncSkuAndDuplicate = function() {
    var name = document.getElementById('pName').value.trim();
    var skuInput = document.getElementById('pSku');
    var editKey = document.getElementById('editProductKey').value;

    if (!skuInput.value && name.length > 2) {
      skuInput.value = autoSku(name);
    }

    var dup = findProductDuplicate(name, editKey);

    document.getElementById('productDuplicate').textContent =
      dup ? '⚠️ Duplicate: ' + dup.name : '';
  };


// ---------- RENDER ----------
function renderProducts(list) {
  var body = document.getElementById('productBody');
  if (!body) return;

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6">No products found</td></tr>';
    return;
  }

  body.innerHTML = list.map(function(p) {
    return '<tr>' +
      '<td class="bold">' + (p.name||'') + '</td>' +
      '<td>' + (p.sku||'') + '</td>' +
      '<td class="r">' + fmt(p.purchasePrice||0) + '</td>' +
      '<td class="r">' + fmt(p.salePrice||0) + '</td>' +
      '<td class="r">' + fmt(p.stock||0) + '</td>' +
      '<td class="r">' +
        '<button class="btn btn-outline btn-sm" onclick="editProduct(\''+p._key+'\')">✏️</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="removeProduct(\''+p._key+'\')">🗑️</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

// ---------- LOAD ----------
window.loadProducts = async function () {
  try {
    console.log('🔄 Loading products...');

    var list = await loadList('product:');

    console.log('📦 Products:', list);

    allProducts = list || [];

    renderProducts(allProducts);

  } catch (err) {
    console.error(err);
    alert('❌ Load failed');
  }
}

// ---------- EDIT ----------
window.editProduct = function(key) {
  var p = allProducts.find(function(x){ return x._key === key; });
  if (!p) return alert('Product not found');

  document.getElementById('productModalTitle').textContent = 'Edit Product';
  document.getElementById('editProductKey').value = key;

  document.getElementById('pName').value = p.name || '';
  document.getElementById('pSku').value = p.sku || '';
  document.getElementById('pUnit').value = p.unit || 'pcs';
  document.getElementById('pBuy').value = p.purchasePrice || 0;
  document.getElementById('pSell').value = p.salePrice || 0;
  document.getElementById('pStock').value = p.stock || 0;

  openModal('addProduct');
};

// ---------- DELETE ----------
window.removeProduct = async function(key) {
  if (!confirm('Delete this product?')) return;

  await deleteItem(key);

  alert('🗑️ Product deleted');

  await loadProducts();
};

// ---------- FILTER ----------
window.filterProducts = function(q) {
  var t = normalize(q);
  renderProducts(allProducts.filter(function(p){
    return normalize(p.name).includes(t) || normalize(p.sku).includes(t);
  }));
};

// ---------- INIT ----------
document.addEventListener('DOMContentLoaded', function () {
  loadProducts();
});
  </script>`;
}

// ============================================================
// CUSTOMERS & SUPPLIERS
// ============================================================
function partiesPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Customers & Suppliers</div><div class="page-sub">Manage business contacts</div></div>
    <button class="btn btn-primary" onclick="openAddParty()">➕ Add</button>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="switchPartyTab('customer',this)">Customers</button>
    <button class="tab" onclick="switchPartyTab('supplier',this)">Suppliers</button>
  </div>
  <div class="search-wrap">
    <span class="icon">🔍</span>
    <input placeholder="Search..." oninput="filterParties(this.value)">
  </div>
  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Address</th><th class="r">Balance</th><th class="r">Actions</th></tr></thead><tbody id="partyBody"></tbody></table>
    </div>
  </div>

  <div class="modal-overlay" id="addParty"><div class="modal">
    <h3 id="partyModalTitle">Add Contact</h3>
    <input type="hidden" id="partyEditKey">
    <div class="form-group">
      <label>Name</label>
      <input id="partyName" placeholder="Name" oninput="partyDuplicateHint()">
      <div id="partyDuplicate" class="text-warning" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div class="form-group"><label>Phone</label><input id="partyPhone" placeholder="Phone"></div>
    <div class="form-group"><label>Address</label><input id="partyAddr" placeholder="Address"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeModal('addParty')">Cancel</button>
      <button class="btn btn-primary" onclick="saveParty()">Save</button>
    </div>
  </div></div>

  <script>
  var allParties = [];
  var partyTab = 'customer';

  function findPartyDuplicate(name, editKey) {
    var n = normalize(name);
    return allParties.find(function(p){ return p.type===partyTab && normalize(p.name)===n && p._key!==editKey; });
  }

  window.partyDuplicateHint = function() {
    var editKey = document.getElementById('partyEditKey').value;
    var dup = findPartyDuplicate(document.getElementById('partyName').value, editKey);
    document.getElementById('partyDuplicate').textContent = dup ? ('Existing '+partyTab+': '+dup.name) : '';
  };

  window.switchPartyTab = function(type, el) {
    partyTab = type;
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('active'); });
    el.classList.add('active');
    renderParties();
  };

  window.openAddParty = function() {
    document.getElementById('partyModalTitle').textContent = 'Add '+(partyTab==='customer'?'Customer':'Supplier');
    document.getElementById('partyEditKey').value = '';
    document.getElementById('partyName').value = '';
    document.getElementById('partyPhone').value = '';
    document.getElementById('partyAddr').value = '';
    document.getElementById('partyDuplicate').textContent = '';
    openModal('addParty');
  };

  window.saveParty = async function() {
    var editKey = document.getElementById('partyEditKey').value;
    var name = document.getElementById('partyName').value.trim();
    if (!name) return alert('Name required');
    var dup = findPartyDuplicate(name, editKey);
    if (dup) return alert((partyTab==='customer'?'Customer':'Supplier')+' already exists');

    if (editKey) {
      var existing = allParties.find(function(x){ return x._key===editKey; });
      if (!existing) return alert('Record not found');
      await saveByKey(editKey, {
        name: name,
        phone: document.getElementById('partyPhone').value.trim(),
        address: document.getElementById('partyAddr').value.trim(),
        type: existing.type,
        balance: Number(existing.balance||0)
      });
    } else {
      var res = await saveItem('party:', {
        name: name,
        phone: document.getElementById('partyPhone').value.trim(),
        address: document.getElementById('partyAddr').value.trim(),
        type: partyTab,
        balance: 0
      });
      if (!res) return;
    }
    closeModal('addParty');
    await loadParties();
  };

  async function loadParties() {
    allParties = await loadList('party:');
    renderParties();
  }

  function renderParties(listInput) {
    var list = listInput || allParties.filter(function(p){ return p.type===partyTab; });
    document.getElementById('partyBody').innerHTML = !list.length
      ? '<tr><td colspan="5" class="empty">No '+partyTab+' found.</td></tr>'
      : list.map(function(p){
          return '<tr>'+
            '<td class="bold">'+(p.name||'')+'</td>'+
            '<td class="text-muted">'+(p.phone||'')+'</td>'+
            '<td class="text-muted">'+(p.address||'')+'</td>'+
            '<td class="r bold '+((p.balance||0)>0?'text-danger':'text-success')+'">'+fmt(p.balance||0)+'</td>'+
            '<td class="r"><button class="btn btn-outline btn-sm" onclick="editParty(\''+p._key+'\')">✏️</button></td>'+
          '</tr>';
        }).join('');
  }

  window.filterParties = function(q) {
    var t = normalize(q);
    renderParties(allParties.filter(function(p){
      return p.type===partyTab && (normalize(p.name).includes(t)||normalize(p.phone).includes(t)||normalize(p.address).includes(t));
    }));
  };

  window.editParty = async function(key) {
    var p = allParties.find(function(x){ return x._key===key; });
    if (!p) return;
    partyTab = p.type;
    document.getElementById('partyModalTitle').textContent = 'Edit '+(p.type==='customer'?'Customer':'Supplier');
    document.getElementById('partyEditKey').value = p._key;
    document.getElementById('partyName').value = p.name||'';
    document.getElementById('partyPhone').value = p.phone||'';
    document.getElementById('partyAddr').value = p.address||'';
    document.getElementById('partyDuplicate').textContent = '';
    openModal('addParty');
  };

  loadParties();
  </script>`;
}

// ============================================================
// PURCHASES
// ============================================================
function purchasesPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Purchases</div><div class="page-sub">Purchase products from suppliers</div></div>
    <button class="btn btn-primary" onclick="openPurchaseModal()">➕ New Purchase</button>
  </div>
  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl"><thead><tr><th>Date</th><th>Purchase #</th><th>Supplier</th><th class="r">Items</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Due</th></tr></thead><tbody id="purchaseBody"></tbody></table>
    </div>
  </div>

  <div class="modal-overlay" id="addPurchase"><div class="modal">
    <h3>New Purchase</h3>
    <div class="form-row">
      <div><label>Date</label><input type="date" id="purDate"></div>
      <div><label>Purchase Number</label><input id="purNo" readonly></div>
    </div>
    <div class="form-group"><label>Supplier</label><select id="purSupplier"></select></div>
    <datalist id="purProductOptions"></datalist>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px">
      <span style="font-weight:600;font-size:13px">Items</span>
      <button class="btn btn-outline btn-sm" onclick="addPurItem()">➕ Add Item</button>
    </div>
    <div id="purItems"></div>
    <div class="form-row" style="margin-top:12px">
      <div><label>Total</label><div id="purTotal" style="font-size:18px;font-weight:700">0</div></div>
      <div><label>Amount Paid</label><input type="number" id="purPaid" placeholder="0"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeModal('addPurchase')">Cancel</button>
      <button class="btn btn-primary" onclick="savePurchase()">Save Purchase</button>
    </div>
  </div></div>

  <script>
  var purProducts = [];
  var purSuppliers = [];
  var purItems = [];

  async function initPurchases() {
    var data = await Promise.all([loadList('purchase:'), loadList('product:'), loadList('party:')]);
    var purchases = data[0];
    purProducts = data[1];
    purSuppliers = data[2].filter(function(p){ return p.type==='supplier'; });

    document.getElementById('purSupplier').innerHTML = '<option value="">Select Supplier</option>'+
      purSuppliers.map(function(s){ return '<option value="'+s._key+'">'+s.name+'</option>'; }).join('');
    document.getElementById('purProductOptions').innerHTML = purProducts.map(function(p){ return '<option value="'+p.name+'"></option>'; }).join('');

    var sorted = purchases.slice().sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });
    document.getElementById('purchaseBody').innerHTML = !sorted.length
      ? '<tr><td colspan="7" class="empty">No purchases yet.</td></tr>'
      : sorted.map(function(p){
          var due=(p.total||0)-(p.paid||0);
          return '<tr>'+
            '<td>'+(p.date||'')+'</td>'+
            '<td class="bold">'+(p.purchaseNo||'-')+'</td>'+
            '<td>'+(p.supplierName||'')+'</td>'+
            '<td class="r">'+((p.items||[]).length)+'</td>'+
            '<td class="r bold">'+fmt(p.total)+'</td>'+
            '<td class="r">'+fmt(p.paid)+'</td>'+
            '<td class="r bold '+(due>0?'text-danger':'text-success')+'">'+fmt(due)+'</td>'+
          '</tr>';
        }).join('');
  }

  window.openPurchaseModal = function() {
    document.getElementById('purDate').value = todayISO();
    document.getElementById('purNo').value = txnNo('PUR');
    document.getElementById('purSupplier').value = '';
    document.getElementById('purPaid').value = '';
    purItems = [];
    addPurItem();
    openModal('addPurchase');
  };

  window.addPurItem = function() {
    purItems.push({ productKey:'', productName:'', qty:1, rate:0, amount:0 });
    renderPurItems();
  };

  function renderPurItems() {
    document.getElementById('purItems').innerHTML = purItems.map(function(item,i){
      return '<div class="form-row" style="grid-template-columns:1fr 70px 100px 100px 36px;align-items:end;margin-bottom:8px">'+
        '<div><input list="purProductOptions" placeholder="Search product" value="'+(item.productName||'')+'" oninput="purSetProduct('+i+',this.value)"></div>'+
        '<div><input type="number" min="1" value="'+(item.qty||1)+'" onchange="purQty('+i+',this.value)"></div>'+
        '<div><input type="number" min="0" value="'+(item.rate||0)+'" onchange="purRate('+i+',this.value)"></div>'+
        '<div style="font-weight:600;padding:10px 0;text-align:right">'+fmt(item.amount)+'</div>'+
        '<div><button class="btn btn-danger btn-sm" onclick="purRemove('+i+')">✕</button></div>'+
      '</div>';
    }).join('');
    document.getElementById('purTotal').textContent = fmt(purItems.reduce(function(s,i){ return s+(i.amount||0); },0));
  }

  window.purSetProduct = function(idx, name) {
    var n = normalize(name);
    var p = purProducts.find(function(x){ return normalize(x.name)===n; });
    purItems[idx].productName = name;
    purItems[idx].productKey = p ? p._key : '';
    if (p) purItems[idx].rate = Number(p.purchasePrice||0);
    purItems[idx].amount = Number(purItems[idx].qty||0)*Number(purItems[idx].rate||0);
    renderPurItems();
  };

  window.purQty = function(idx, value) {
    purItems[idx].qty = Math.max(1, Number(value||1));
    purItems[idx].amount = Number(purItems[idx].qty)*Number(purItems[idx].rate||0);
    renderPurItems();
  };

  window.purRate = function(idx, value) {
    purItems[idx].rate = Math.max(0, Number(value||0));
    purItems[idx].amount = Number(purItems[idx].qty||0)*Number(purItems[idx].rate);
    renderPurItems();
  };

  window.purRemove = function(idx) {
    purItems.splice(idx,1);
    if (!purItems.length) purItems.push({productKey:'',productName:'',qty:1,rate:0,amount:0});
    renderPurItems();
  };

  window.savePurchase = async function() {
    var supplierKey = document.getElementById('purSupplier').value;
    var supplier = purSuppliers.find(function(s){ return s._key===supplierKey; });
    if (!supplier) return alert('Please select supplier');
    var validItems = purItems.filter(function(i){ return i.productKey && i.qty>0; });
    if (!validItems.length) return alert('Add at least one valid product item');

    var total = validItems.reduce(function(s,i){ return s+Number(i.amount||0); },0);
    var paid  = Number(document.getElementById('purPaid').value||0);

    var res = await saveItem('purchase:', {
      date: document.getElementById('purDate').value||todayISO(),
      purchaseNo: document.getElementById('purNo').value,
      supplierId: supplier._key,
      supplierName: supplier.name,
      items: validItems, total: total, paid: paid
    });
    if (!res) return;

    for (var j=0; j<validItems.length; j++) {
      var item = validItems[j];
      var product = purProducts.find(function(p){ return p._key===item.productKey; });
      if (!product) continue;
      var up = cleanForSave(product);
      up.stock = Number(product.stock||0)+Number(item.qty||0);
      await saveByKey(product._key, up);
    }

    var us = cleanForSave(supplier);
    us.balance = Number(supplier.balance||0)+(total-paid);
    await saveByKey(supplier._key, us);

    closeModal('addPurchase');
    await initPurchases();
  };

  initPurchases();
  </script>`;
}

// ============================================================
// SALES + PRINTABLE INVOICE
// ============================================================
function salesPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Sales</div><div class="page-sub">Sell products and print invoices</div></div>
    <button class="btn btn-primary" onclick="openSaleModal()">➕ New Sale</button>
  </div>
  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl"><thead><tr><th>Date</th><th>Invoice #</th><th>Customer</th><th class="r">Items</th><th class="r">Total</th><th class="r">Received</th><th class="r">Due</th></tr></thead><tbody id="saleBody"></tbody></table>
    </div>
  </div>

  <div class="modal-overlay" id="addSale"><div class="modal">
    <h3>New Sale</h3>
    <div class="form-row">
      <div><label>Date</label><input type="date" id="saleDate"></div>
      <div><label>Invoice Number</label><input id="saleNo" readonly></div>
    </div>
    <div class="form-group"><label>Customer</label><select id="saleCustomer"></select></div>
    <datalist id="saleProductOptions"></datalist>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px">
      <span style="font-weight:600;font-size:13px">Items</span>
      <button class="btn btn-outline btn-sm" onclick="addSaleItem()">➕ Add Item</button>
    </div>
    <div id="saleItems"></div>
    <div class="form-row" style="margin-top:12px">
      <div><label>Total</label><div id="saleTotal" style="font-size:18px;font-weight:700">0</div></div>
      <div><label>Amount Received</label><input type="number" id="saleRcvd" placeholder="0"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeModal('addSale')">Cancel</button>
      <button class="btn btn-primary" onclick="saveSale()">Save Sale</button>
    </div>
  </div></div>

  <div class="modal-overlay" id="viewInvoice"><div class="modal" style="max-width:820px">
    <h3>Invoice Preview</h3>
    <div id="invoiceContent"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn btn-outline" onclick="closeModal('viewInvoice')">Close</button>
      <button class="btn btn-primary" onclick="printInvoice()">🖨️ Print</button>
    </div>
  </div></div>

  <script>
  var saleProducts = [];
  var saleCustomers = [];
  var allSales = [];
  var _saleItems = [];   // underscore-prefixed to avoid any collision
  var currentInvoice = null;

  // Override global stubs with real implementations
  window.addSaleItem = function() {
    _saleItems.push({ productKey:'', productName:'', qty:1, rate:0, amount:0 });
    renderSaleItems();
  };

  window.openSaleModal = function() {
    document.getElementById('saleDate').value = todayISO();
    document.getElementById('saleNo').value = txnNo('INV');
    document.getElementById('saleCustomer').value = '';
    document.getElementById('saleRcvd').value = '';
    _saleItems = [];
    window.addSaleItem();
    openModal('addSale');
  };

  window.saveSale = async function() {
    var customerKey = document.getElementById('saleCustomer').value;
    var customer = saleCustomers.find(function(c){ return c._key===customerKey; });
    if (!customer) return alert('Please select customer');
    var validItems = _saleItems.filter(function(i){ return i.productKey && i.qty>0; });
    if (!validItems.length) return alert('Add at least one valid product item');

    for (var i=0; i<validItems.length; i++) {
      var product = saleProducts.find(function(p){ return p._key===validItems[i].productKey; });
      if (!product) return alert('Invalid product');
      if ((product.stock||0) < (validItems[i].qty||0)) return alert('Insufficient stock for '+product.name+'. Available: '+fmt(product.stock||0));
    }

    var total = validItems.reduce(function(s,i){ return s+Number(i.amount||0); },0);
    var received = Number(document.getElementById('saleRcvd').value||0);

    var res = await saveItem('sale:', {
      date: document.getElementById('saleDate').value||todayISO(),
      invoiceNo: document.getElementById('saleNo').value,
      customerId: customer._key,
      customerName: customer.name,
      items: validItems, total: total, received: received
    });
    if (!res) return;

    for (var j=0; j<validItems.length; j++) {
      var item = validItems[j];
      var sp = saleProducts.find(function(p){ return p._key===item.productKey; });
      if (!sp) continue;
      var up = cleanForSave(sp);
      up.stock = Number(sp.stock||0)-Number(item.qty||0);
      await saveByKey(sp._key, up);
    }

    var uc = cleanForSave(customer);
    uc.balance = Number(customer.balance||0)+(total-received);
    await saveByKey(customer._key, uc);

    closeModal('addSale');
    await initSales();
  };

  function renderSaleItems() {
    document.getElementById('saleItems').innerHTML = _saleItems.map(function(item,i){
      return '<div class="form-row" style="grid-template-columns:1fr 70px 100px 100px 36px;align-items:end;margin-bottom:8px">'+
        '<div><input list="saleProductOptions" placeholder="Search product" value="'+(item.productName||'')+'" oninput="saleSetProduct('+i+',this.value)"></div>'+
        '<div><input type="number" min="1" value="'+(item.qty||1)+'" onchange="saleQty('+i+',this.value)"></div>'+
        '<div><input type="number" min="0" value="'+(item.rate||0)+'" onchange="saleRate('+i+',this.value)"></div>'+
        '<div style="font-weight:600;padding:10px 0;text-align:right">'+fmt(item.amount)+'</div>'+
        '<div><button class="btn btn-danger btn-sm" onclick="saleRemove('+i+')">✕</button></div>'+
      '</div>';
    }).join('');
    document.getElementById('saleTotal').textContent = fmt(_saleItems.reduce(function(s,i){ return s+(i.amount||0); },0));
  }

  window.saleSetProduct = function(idx, name) {
    var n = normalize(name);
    var p = saleProducts.find(function(x){ return normalize(x.name)===n; });
    _saleItems[idx].productName = name;
    _saleItems[idx].productKey = p ? p._key : '';
    if (p) _saleItems[idx].rate = Number(p.salePrice||0);
    _saleItems[idx].amount = Number(_saleItems[idx].qty||0)*Number(_saleItems[idx].rate||0);
    renderSaleItems();
  };

  window.saleQty = function(idx, value) {
    _saleItems[idx].qty = Math.max(1, Number(value||1));
    _saleItems[idx].amount = Number(_saleItems[idx].qty)*Number(_saleItems[idx].rate||0);
    renderSaleItems();
  };

  window.saleRate = function(idx, value) {
    _saleItems[idx].rate = Math.max(0, Number(value||0));
    _saleItems[idx].amount = Number(_saleItems[idx].qty||0)*Number(_saleItems[idx].rate);
    renderSaleItems();
  };

  window.saleRemove = function(idx) {
    _saleItems.splice(idx,1);
    if (!_saleItems.length) _saleItems.push({productKey:'',productName:'',qty:1,rate:0,amount:0});
    renderSaleItems();
  };

  window.viewInvoiceByKey = function(key) {
    var sale = allSales.find(function(s){ return s._key===key; });
    if (!sale) return;
    currentInvoice = sale;
    var due = Number(sale.total||0)-Number(sale.received||0);
    var itemsHtml = (sale.items||[]).map(function(item,i){
      return '<tr><td>'+(i+1)+'</td><td>'+(item.productName||'')+'</td><td class="r">'+fmt(item.qty||0)+'</td><td class="r">'+fmt(item.rate||0)+'</td><td class="r bold">'+fmt(item.amount||0)+'</td></tr>';
    }).join('');
    document.getElementById('invoiceContent').innerHTML =
      '<div class="invoice-paper" id="invoicePrintArea">'+
        '<div class="invoice-head">'+
          '<div><h2 style="margin:0;font-size:22px">Invoice</h2><div class="text-muted" style="font-size:12px">BizManager</div></div>'+
          '<div style="text-align:right"><div><strong>Invoice #:</strong> '+(sale.invoiceNo||'-')+'</div><div><strong>Date:</strong> '+(sale.date||'-')+'</div></div>'+
        '</div>'+
        '<div style="margin:10px 0 14px"><strong>Customer:</strong> '+(sale.customerName||'-')+'</div>'+
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>'+itemsHtml+'</tbody></table></div>'+
        '<div style="display:grid;justify-content:end;margin-top:12px;gap:6px">'+
          '<div><strong>Total:</strong> '+fmt(sale.total||0)+'</div>'+
          '<div><strong>Received:</strong> '+fmt(sale.received||0)+'</div>'+
          '<div><strong>Due:</strong> <span class="'+(due>0?'text-danger':'text-success')+'">'+fmt(due)+'</span></div>'+
        '</div>'+
      '</div>';
    openModal('viewInvoice');
  };

  window.printInvoice = function() {
    if (!currentInvoice) return;
    var area = document.getElementById('invoicePrintArea');
    if (!area) return;
    var w = window.open('','_blank');
    if (!w) return alert('Allow popups to print');
    w.document.write('<html><head><title>Invoice '+(currentInvoice.invoiceNo||'')+'</title><style>body{font-family:Arial;padding:20px}.tbl{width:100%;border-collapse:collapse}.tbl th,.tbl td{border:1px solid #ddd;padding:8px}.r{text-align:right}</style></head><body>'+area.innerHTML+'</body></html>');
    w.document.close();
    w.print();
  };

  async function initSales() {
    var data = await Promise.all([loadList('sale:'), loadList('product:'), loadList('party:')]);
    allSales = data[0];
    saleProducts = data[1];
    saleCustomers = data[2].filter(function(p){ return p.type==='customer'; });

    document.getElementById('saleCustomer').innerHTML = '<option value="">Select Customer</option>'+
      saleCustomers.map(function(c){ return '<option value="'+c._key+'">'+c.name+'</option>'; }).join('');
    document.getElementById('saleProductOptions').innerHTML = saleProducts.map(function(p){ return '<option value="'+p.name+'"></option>'; }).join('');

    var sorted = allSales.slice().sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });
    document.getElementById('saleBody').innerHTML = !sorted.length
      ? '<tr><td colspan="7" class="empty">No sales yet.</td></tr>'
      : sorted.map(function(s){
          var due=(s.total||0)-(s.received||0);
          return '<tr>'+
            '<td>'+(s.date||'')+'</td>'+
            '<td><span class="clickable" onclick="viewInvoiceByKey(\''+s._key+'\')">'+( s.invoiceNo||'-')+'</span></td>'+
            '<td class="bold">'+(s.customerName||'')+'</td>'+
            '<td class="r">'+((s.items||[]).length)+'</td>'+
            '<td class="r bold">'+fmt(s.total)+'</td>'+
            '<td class="r">'+fmt(s.received)+'</td>'+
            '<td class="r bold '+(due>0?'text-danger':'text-success')+'">'+fmt(due)+'</td>'+
          '</tr>';
        }).join('');
  }

  initSales();
  </script>`;
}

// ============================================================
// RECEIPTS & PAYMENTS
// ============================================================
function paymentsPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Receipts & Payments</div><div class="page-sub">Record cash and bank transactions</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-outline" onclick="openBankModal()">🏦 Manage Banks</button>
      <button class="btn btn-primary" onclick="openPaymentModal()">➕ New</button>
    </div>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="switchPayTab('receipt',this)">Receipts</button>
    <button class="tab" onclick="switchPayTab('payment',this)">Payments</button>
  </div>

  <div class="summary-grid" id="paySummary"></div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl"><thead><tr><th>Date</th><th>No</th><th>Party</th><th>Method</th><th class="r">Amount</th><th>Description</th></tr></thead><tbody id="payBody"></tbody></table>
    </div>
  </div>

  <!-- Payment modal -->
  <div class="modal-overlay" id="addPayment"><div class="modal">
    <h3 id="payModalTitle">New Receipt</h3>
    <div class="form-row">
      <div><label>Date</label><input type="date" id="payDate"></div>
      <div><label id="payNoLabel">Receipt Number</label><input id="payNo" readonly></div>
    </div>
    <datalist id="payPartyList"></datalist>
    <div class="form-group">
      <label id="payPartyLabel">Customer</label>
      <input id="payPartySearch" list="payPartyList" placeholder="Search name" oninput="resolvePayParty()">
      <input type="hidden" id="payPartyKey">
    </div>
    <div class="form-group">
      <label>Method</label>
      <div class="method-toggle">
        <div class="method-btn active pay-method" onclick="choosePayMethod('cash',this)">💵 Cash</div>
        <div class="method-btn pay-method" onclick="choosePayMethod('bank',this)">🏦 Bank</div>
      </div>
      <input type="hidden" id="payMethod" value="cash">
    </div>
    <div class="form-group hidden" id="payBankWrap">
      <label>Bank Account</label>
      <select id="payBank"></select>
    </div>
    <div class="form-group"><label>Amount</label><input type="number" id="payAmt" placeholder="0"></div>
    <div class="form-group"><label>Description</label><input id="payDesc" placeholder="Optional"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeModal('addPayment')">Cancel</button>
      <button class="btn btn-primary" onclick="savePayment()">Save</button>
    </div>
  </div></div>

  <!-- Bank management modal -->
  <div class="modal-overlay" id="bankModal"><div class="modal" style="max-width:560px">
    <h3>Bank Accounts</h3>
    <div class="form-row" style="grid-template-columns:1fr 140px auto">
      <div><label>Bank Name</label><input id="pmtBankName" placeholder="e.g. Dutch Bangla"></div>
      <div><label>Opening Balance</label><input type="number" id="pmtBankOpening" placeholder="0"></div>
      <div style="align-self:end"><button class="btn btn-primary" onclick="addBank()">Add Bank</button></div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-top:12px">
      <div class="table-wrap">
        <table class="tbl"><thead><tr><th>Bank</th><th class="r">Balance</th><th class="r">Actions</th></tr></thead><tbody id="bankBody"></tbody></table>
      </div>
    </div>
    <div style="text-align:right;margin-top:14px"><button class="btn btn-outline" onclick="closeModal('bankModal')">Close</button></div>
  </div></div>

  <script>
  var allPayments = [];
  var allParties  = [];
  var allBanks    = [];
  var payTab = 'receipt';

  async function initPayments() {
    var data = await Promise.all([loadList('payment:'), loadList('party:'), loadList('bank:')]);
    allPayments = data[0];
    allParties  = data[1];
    allBanks    = data[2];
    renderPayments();
    renderPaySummary();
    renderBanks();
  }

  function renderPaySummary() {
    var rCash = allPayments.filter(function(p){return p.type==='receipt'&&p.method==='cash';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var rBank = allPayments.filter(function(p){return p.type==='receipt'&&p.method==='bank';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var pCash = allPayments.filter(function(p){return p.type==='payment'&&p.method==='cash';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var pBank = allPayments.filter(function(p){return p.type==='payment'&&p.method==='bank';}).reduce(function(s,p){return s+(p.amount||0);},0);
    document.getElementById('paySummary').innerHTML = [
      {label:'Cash Receipts',value:fmt(rCash),color:'var(--accent)'},
      {label:'Bank Receipts',value:fmt(rBank),color:'var(--primary)'},
      {label:'Cash Payments',value:fmt(pCash),color:'var(--danger)'},
      {label:'Bank Payments',value:fmt(pBank),color:'var(--warning)'}
    ].map(function(c){ return '<div class="summary-card"><div class="label">'+c.label+'</div><div class="value" style="color:'+c.color+'">'+c.value+'</div></div>'; }).join('');
  }

  function renderPayments() {
    var list = allPayments.filter(function(p){return p.type===payTab;}).sort(function(a,b){return (b.date||'').localeCompare(a.date||'');});
    document.getElementById('payBody').innerHTML = !list.length
      ? '<tr><td colspan="6" class="empty">No '+payTab+' recorded.</td></tr>'
      : list.map(function(p){
          var ml = p.method==='bank'
            ? '<span class="badge badge-bank">bank</span>'+(p.bankName?' <span class="text-muted">('+p.bankName+')</span>':'')
            : '<span class="badge badge-cash">cash</span>';
          return '<tr>'+
            '<td>'+(p.date||'')+'</td>'+
            '<td class="bold">'+(p.number||'-')+'</td>'+
            '<td class="bold">'+(p.partyName||'')+'</td>'+
            '<td>'+ml+'</td>'+
            '<td class="r bold">'+fmt(p.amount)+'</td>'+
            '<td class="text-muted">'+(p.description||'')+'</td>'+
          '</tr>';
        }).join('');
  }

  window.switchPayTab = function(type, el) {
    payTab = type;
    document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
    el.classList.add('active');
    renderPayments();
  };

  window.openPaymentModal = function() {
    var needType = payTab==='receipt'?'customer':'supplier';
    var options = allParties.filter(function(p){return p.type===needType;});
    document.getElementById('payModalTitle').textContent = payTab==='receipt'?'New Receipt':'New Payment';
    document.getElementById('payNoLabel').textContent = payTab==='receipt'?'Receipt Number':'Payment Number';
    document.getElementById('payPartyLabel').textContent = payTab==='receipt'?'Customer':'Supplier';
    document.getElementById('payDate').value = todayISO();
    document.getElementById('payNo').value = txnNo(payTab==='receipt'?'RCT':'PAY');
    document.getElementById('payPartySearch').value = '';
    document.getElementById('payPartyKey').value = '';
    document.getElementById('payAmt').value = '';
    document.getElementById('payDesc').value = '';
    document.getElementById('payMethod').value = 'cash';
    document.getElementById('payBankWrap').classList.add('hidden');
    document.querySelectorAll('.pay-method').forEach(function(x,idx){x.classList.toggle('active',idx===0);});
    document.getElementById('payPartyList').innerHTML = options.map(function(p){return '<option value="'+p.name+'"></option>';}).join('');
    document.getElementById('payBank').innerHTML = '<option value="">Select Bank</option>'+allBanks.map(function(b){return '<option value="'+b._key+'">'+b.name+'</option>';}).join('');
    openModal('addPayment');
  };

  window.resolvePayParty = function() {
    var selectedName = normalize(document.getElementById('payPartySearch').value);
    var requiredType = payTab==='receipt'?'customer':'supplier';
    var party = allParties.find(function(p){ return p.type===requiredType && normalize(p.name)===selectedName; });
    document.getElementById('payPartyKey').value = party ? party._key : '';
  };

  window.choosePayMethod = function(method, el) {
    setMethod(el, method, 'payMethod', '.pay-method');
    document.getElementById('payBankWrap').classList.toggle('hidden', method!=='bank');
  };

  window.savePayment = async function() {
    window.resolvePayParty();
    var partyKey = document.getElementById('payPartyKey').value;
    var party = allParties.find(function(p){return p._key===partyKey;});
    var amount = Number(document.getElementById('payAmt').value||0);
    var method = document.getElementById('payMethod').value;
    var bankKey = document.getElementById('payBank').value;
    var bank = allBanks.find(function(b){return b._key===bankKey;});

    if (!party) return alert('Select valid '+(payTab==='receipt'?'customer':'supplier'));
    if (amount<=0) return alert('Enter valid amount');
    if (method==='bank' && !bank) return alert('Select bank account');

    var res = await saveItem('payment:', {
      date: document.getElementById('payDate').value||todayISO(),
      number: document.getElementById('payNo').value,
      type: payTab,
      partyId: party._key,
      partyName: party.name,
      partyType: party.type,
      method: method,
      bankId: method==='bank'?bank._key:'',
      bankName: method==='bank'?bank.name:'',
      amount: amount,
      description: document.getElementById('payDesc').value.trim()
    });
    if (!res) return;

    var up = cleanForSave(party);
    up.balance = Number(party.balance||0)-amount;
    await saveByKey(party._key, up);

    if (method==='bank') {
      var ub = cleanForSave(bank);
      ub.openingBalance = Number(ub.openingBalance||0)+(payTab==='receipt'?amount:-amount);
      await saveByKey(bank._key, ub);
    }

    closeModal('addPayment');
    await initPayments();
  };

  window.openBankModal = function() {
    document.getElementById('pmtBankName').value = '';
    document.getElementById('pmtBankOpening').value = '';
    renderBanks();
    openModal('bankModal');
  };

  window.addBank = async function() {
    var name = document.getElementById('pmtBankName').value.trim();
    var opening = Number(document.getElementById('pmtBankOpening').value||0);
    if (!name) return alert('Bank name required');
    var exists = allBanks.find(function(b){return normalize(b.name)===normalize(name);});
    if (exists) return alert('Bank already exists');
    var res = await saveItem('bank:', {name:name, openingBalance:opening});
    if (!res) return;
    allBanks = await loadList('bank:');
    document.getElementById('pmtBankName').value = '';
    document.getElementById('pmtBankOpening').value = '';
    renderBanks();
  };

  function renderBanks() {
    document.getElementById('bankBody').innerHTML = !allBanks.length
      ? '<tr><td colspan="3" class="empty">No banks added yet.</td></tr>'
      : allBanks.map(function(b){
          return '<tr>'+
            '<td class="bold">'+(b.name||'')+'</td>'+
            '<td class="r">'+fmt(b.openingBalance||0)+'</td>'+
            '<td class="r"><button class="btn btn-danger btn-sm" onclick="removeBank(\''+b._key+'\')">Delete</button></td>'+
          '</tr>';
        }).join('');
  }

  window.removeBank = async function(key) {
    var inUse = allPayments.some(function(p){return p.bankId===key;});
    if (inUse) return alert('Cannot delete bank used in transactions');
    await deleteItem(key, true);
    allBanks = await loadList('bank:');
    renderBanks();
  };

  initPayments();
  </script>`;
}

// ============================================================
// EXPENSES
// ============================================================
function expensesPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Expenses</div><div class="page-sub">Track expenses by head and method</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-outline" onclick="openModal('manageHeads')">⚙️ Manage Heads</button>
      <button class="btn btn-outline" onclick="openExpenseBankModal()">🏦 Banks</button>
      <button class="btn btn-primary" onclick="openExpenseModal()">➕ Add Expense</button>
    </div>
  </div>

  <div class="summary-grid" id="expenseSummary"></div>

  <div class="search-wrap">
    <span class="icon">🔍</span>
    <input placeholder="Search expense..." oninput="filterExpenses(this.value)">
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl"><thead><tr><th>Date</th><th>Expense #</th><th>Head</th><th>Sub-Head</th><th>Method</th><th class="r">Amount</th><th>Description</th></tr></thead><tbody id="expBody"></tbody></table>
    </div>
  </div>

  <!-- Manage Heads modal -->
  <div class="modal-overlay" id="manageHeads"><div class="modal">
    <h3>Expense Heads & Sub-Heads</h3>
    <div class="form-group">
      <label>Add Head</label>
      <div style="display:flex;gap:8px">
        <input id="newHead" placeholder="e.g. Office, Travel">
        <button class="btn btn-primary btn-sm" onclick="addHead()">Add</button>
      </div>
      <div id="headWarn" class="text-warning" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div id="headsList" style="margin:12px 0"></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
    <div class="form-group">
      <label>Add Sub-Head</label>
      <div style="display:flex;gap:8px">
        <select id="subHeadParent" style="flex:1"></select>
        <input id="newSubHead" placeholder="Sub-head name" style="flex:1">
        <button class="btn btn-primary btn-sm" onclick="addSubHead()">Add</button>
      </div>
      <div id="subHeadWarn" class="text-warning" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div id="subHeadsList" style="margin:12px 0"></div>
    <div style="text-align:right;margin-top:16px"><button class="btn btn-outline" onclick="closeModal('manageHeads')">Close</button></div>
  </div></div>

  <!-- Add Expense modal -->
  <div class="modal-overlay" id="addExpense"><div class="modal">
    <h3>New Expense</h3>
    <div class="form-row">
      <div><label>Date</label><input type="date" id="expDate"></div>
      <div><label>Expense Number</label><input id="expNo" readonly></div>
    </div>
    <div class="form-row">
      <div><label>Head</label><select id="expHead" onchange="loadSubHeadsFor()"></select></div>
      <div><label>Sub-Head</label><select id="expSubHead"></select></div>
    </div>
    <div class="form-group">
      <label>Method</label>
      <div class="method-toggle">
        <div class="method-btn active exp-method" onclick="setExpenseMethod('cash',this)">💵 Cash</div>
        <div class="method-btn exp-method" onclick="setExpenseMethod('bank',this)">🏦 Bank</div>
      </div>
      <input type="hidden" id="expMethod" value="cash">
    </div>
    <div class="form-group hidden" id="expBankWrap">
      <label>Bank Account</label>
      <select id="expBank"></select>
    </div>
    <div class="form-group"><label>Amount</label><input type="number" id="expAmt" placeholder="0"></div>
    <div class="form-group"><label>Description</label><input id="expDesc" placeholder="Description"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeModal('addExpense')">Cancel</button>
      <button class="btn btn-primary" onclick="saveExpense()">Save</button>
    </div>
  </div></div>

  <!-- Expense Bank modal -->
  <div class="modal-overlay" id="expenseBankModal"><div class="modal" style="max-width:560px">
    <h3>Bank Accounts</h3>
    <div class="form-row" style="grid-template-columns:1fr 140px auto">
      <div><label>Bank Name</label><input id="expBankName" placeholder="e.g. City Bank"></div>
      <div><label>Opening Balance</label><input type="number" id="expBankOpening" placeholder="0"></div>
      <div style="align-self:end"><button class="btn btn-primary" onclick="addExpenseBank()">Add Bank</button></div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-top:12px">
      <div class="table-wrap">
        <table class="tbl"><thead><tr><th>Bank</th><th class="r">Balance</th><th class="r">Action</th></tr></thead><tbody id="expBankBody"></tbody></table>
      </div>
    </div>
    <div style="text-align:right;margin-top:14px"><button class="btn btn-outline" onclick="closeModal('expenseBankModal')">Close</button></div>
  </div></div>

  <script>
  var expHeads    = [];
  var expSubHeads = [];
  var allExpenses = [];
  var expBanks    = [];

  async function initExpenses() {
    var data = await Promise.all([loadList('exphead:'), loadList('expsubhead:'), loadList('expense:'), loadList('bank:')]);
    expHeads    = data[0];
    expSubHeads = data[1];
    allExpenses = data[2];
    expBanks    = data[3];
    renderExpenses(allExpenses);
    renderHeadsUI();
    renderExpenseSummary();
    renderExpenseBanks();
  }

  function renderExpenseSummary() {
    var cash  = allExpenses.filter(function(e){return e.method==='cash';}).reduce(function(s,e){return s+(e.amount||0);},0);
    var bank  = allExpenses.filter(function(e){return e.method==='bank';}).reduce(function(s,e){return s+(e.amount||0);},0);
    document.getElementById('expenseSummary').innerHTML = [
      {label:'Cash Expense',value:fmt(cash),color:'var(--danger)'},
      {label:'Bank Expense',value:fmt(bank),color:'var(--warning)'},
      {label:'Total Expense',value:fmt(cash+bank),color:'var(--primary)'}
    ].map(function(c){return '<div class="summary-card"><div class="label">'+c.label+'</div><div class="value" style="color:'+c.color+'">'+c.value+'</div></div>';}).join('');
  }

  function renderExpenses(list) {
    var sorted = list.slice().sort(function(a,b){return (b.date||'').localeCompare(a.date||'');});
    document.getElementById('expBody').innerHTML = !sorted.length
      ? '<tr><td colspan="7" class="empty">No expenses recorded.</td></tr>'
      : sorted.map(function(e){
          var method = e.method==='bank'
            ? '<span class="badge badge-bank">bank</span>'+(e.bankName?' <span class="text-muted">('+e.bankName+')</span>':'')
            : '<span class="badge badge-cash">cash</span>';
          return '<tr>'+
            '<td>'+(e.date||'')+'</td>'+
            '<td class="bold">'+(e.expenseNo||'-')+'</td>'+
            '<td class="bold">'+(e.headName||'')+'</td>'+
            '<td class="text-muted">'+(e.subHeadName||'—')+'</td>'+
            '<td>'+method+'</td>'+
            '<td class="r bold">'+fmt(e.amount)+'</td>'+
            '<td class="text-muted">'+(e.description||'')+'</td>'+
          '</tr>';
        }).join('');
  }

  window.filterExpenses = function(q) {
    var t = normalize(q);
    renderExpenses(allExpenses.filter(function(e){
      return normalize(e.headName).includes(t)||normalize(e.subHeadName).includes(t)||normalize(e.description).includes(t);
    }));
  };

  function renderHeadsUI() {
    document.getElementById('headsList').innerHTML = expHeads.map(function(h){
      return '<span style="display:inline-block;padding:4px 10px;background:var(--bg);border-radius:6px;font-size:12px;font-weight:500;margin:2px">'+h.name+'</span>';
    }).join(' ');
    document.getElementById('subHeadParent').innerHTML = '<option value="">Select Head</option>'+
      expHeads.map(function(h){return '<option value="'+h._key+'">'+h.name+'</option>';}).join('');
    var grouped = {};
    expSubHeads.forEach(function(s){
      var head = expHeads.find(function(h){return h._key===s.headId;});
      var key = head?head.name:'Unassigned';
      if (!grouped[key]) grouped[key]=[];
      grouped[key].push(s.name);
    });
    document.getElementById('subHeadsList').innerHTML = Object.keys(grouped).map(function(k){
      return '<div style="font-size:12px;margin:4px 0"><strong>'+k+':</strong> '+grouped[k].join(', ')+'</div>';
    }).join('');
  }

  window.addHead = async function() {
    var name = document.getElementById('newHead').value.trim();
    if (!name) return;
    var exists = expHeads.find(function(h){return normalize(h.name)===normalize(name);});
    if (exists) { document.getElementById('headWarn').textContent = '⚠️ Already exists: '+exists.name; return; }
    document.getElementById('headWarn').textContent = '';
    var res = await saveItem('exphead:', {name:name});
    if (!res) return;
    document.getElementById('newHead').value = '';
    expHeads = await loadList('exphead:');
    renderHeadsUI();
  };

  window.addSubHead = async function() {
    var headId = document.getElementById('subHeadParent').value;
    var name   = document.getElementById('newSubHead').value.trim();
    if (!headId || !name) return alert('Select a head and enter sub-head name');
    var exists = expSubHeads.find(function(s){return s.headId===headId && normalize(s.name)===normalize(name);});
    if (exists) { document.getElementById('subHeadWarn').textContent = 'Sub-head already exists'; return; }
    document.getElementById('subHeadWarn').textContent = '';
    var res = await saveItem('expsubhead:', {headId:headId, name:name});
    if (!res) return;
    document.getElementById('newSubHead').value = '';
    expSubHeads = await loadList('expsubhead:');
    renderHeadsUI();
  };

  window.openExpenseModal = function() {
    document.getElementById('expDate').value = todayISO();
    document.getElementById('expNo').value = txnNo('EXP');
    document.getElementById('expAmt').value = '';
    document.getElementById('expDesc').value = '';
    document.getElementById('expMethod').value = 'cash';
    document.getElementById('expBankWrap').classList.add('hidden');
    document.querySelectorAll('.exp-method').forEach(function(x,idx){x.classList.toggle('active',idx===0);});
    document.getElementById('expHead').innerHTML = '<option value="">Select Head</option>'+expHeads.map(function(h){return '<option value="'+h._key+'">'+h.name+'</option>';}).join('');
    document.getElementById('expSubHead').innerHTML = '<option value="">Optional</option>';
    document.getElementById('expBank').innerHTML = '<option value="">Select Bank</option>'+expBanks.map(function(b){return '<option value="'+b._key+'">'+b.name+'</option>';}).join('');
    openModal('addExpense');
  };

  window.loadSubHeadsFor = function() {
    var headId = document.getElementById('expHead').value;
    var subs = expSubHeads.filter(function(s){return s.headId===headId;});
    document.getElementById('expSubHead').innerHTML = '<option value="">Optional</option>'+subs.map(function(s){return '<option value="'+s._key+'">'+s.name+'</option>';}).join('');
  };

  window.setExpenseMethod = function(method, el) {
    setMethod(el, method, 'expMethod', '.exp-method');
    document.getElementById('expBankWrap').classList.toggle('hidden', method!=='bank');
  };

  window.saveExpense = async function() {
    var headKey = document.getElementById('expHead').value;
    var subKey  = document.getElementById('expSubHead').value;
    var amount  = Number(document.getElementById('expAmt').value||0);
    var method  = document.getElementById('expMethod').value;
    var bankKey = document.getElementById('expBank').value;

    var head = expHeads.find(function(h){return h._key===headKey;});
    var sub  = expSubHeads.find(function(s){return s._key===subKey;});
    var bank = expBanks.find(function(b){return b._key===bankKey;});

    if (!head) return alert('Select expense head');
    if (amount<=0) return alert('Enter valid amount');
    if (method==='bank' && !bank) return alert('Select bank account');

    var res = await saveItem('expense:', {
      date: document.getElementById('expDate').value||todayISO(),
      expenseNo: document.getElementById('expNo').value,
      headId: head._key, headName: head.name,
      subHeadId: sub?sub._key:'', subHeadName: sub?sub.name:'',
      amount: amount,
      description: document.getElementById('expDesc').value.trim(),
      method: method,
      bankId: method==='bank'?bank._key:'',
      bankName: method==='bank'?bank.name:''
    });
    if (!res) return;

    if (method==='bank') {
      var ub = cleanForSave(bank);
      ub.openingBalance = Number(ub.openingBalance||0)-amount;
      await saveByKey(bank._key, ub);
    }

    closeModal('addExpense');
    await initExpenses();
  };

  window.openExpenseBankModal = function() {
    document.getElementById('expBankName').value = '';
    document.getElementById('expBankOpening').value = '';
    renderExpenseBanks();
    openModal('expenseBankModal');
  };

  function renderExpenseBanks() {
    document.getElementById('expBankBody').innerHTML = !expBanks.length
      ? '<tr><td colspan="3" class="empty">No banks added yet.</td></tr>'
      : expBanks.map(function(b){
          return '<tr>'+
            '<td class="bold">'+(b.name||'')+'</td>'+
            '<td class="r">'+fmt(b.openingBalance||0)+'</td>'+
            '<td class="r"><button class="btn btn-danger btn-sm" onclick="removeExpenseBank(\''+b._key+'\')">Delete</button></td>'+
          '</tr>';
        }).join('');
  }

  window.addExpenseBank = async function() {
    var name    = document.getElementById('expBankName').value.trim();
    var opening = Number(document.getElementById('expBankOpening').value||0);
    if (!name) return alert('Bank name required');
    var exists = expBanks.find(function(b){return normalize(b.name)===normalize(name);});
    if (exists) return alert('Bank already exists');
    var res = await saveItem('bank:', {name:name, openingBalance:opening});
    if (!res) return;
    expBanks = await loadList('bank:');
    renderExpenseBanks();
  };

  window.removeExpenseBank = async function(key) {
    var used = allExpenses.some(function(e){return e.bankId===key;});
    if (used) return alert('Cannot delete bank used in expense entries');
    await deleteItem(key, true);
    expBanks = await loadList('bank:');
    renderExpenseBanks();
  };

  initExpenses();
  </script>`;
}

// ============================================================
// LEDGER
// ============================================================
function ledgerPage() {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `
  <div class="page-header">
    <div><div class="page-title">Ledger</div><div class="page-sub">Customer/supplier ledger by timeframe</div></div>
  </div>
  <div class="card" style="margin-bottom:16px;max-width:820px">
    <div class="form-row" style="grid-template-columns:2fr 1fr 1fr">
      <div><label>Customer / Supplier</label><select id="ledgerParty" onchange="loadLedger()"><option value="">Select</option></select></div>
      <div><label>From</label><input type="date" id="ledgerFrom" value="${from}" onchange="loadLedger()"></div>
      <div><label>To</label><input type="date" id="ledgerTo" value="${to}" onchange="loadLedger()"></div>
    </div>
  </div>
  <div id="ledgerContent"></div>
  <script>
  var ledgerParties=[], ledgerSales=[], ledgerPurchases=[], ledgerPayments=[];

  async function initLedger() {
    var data = await Promise.all([loadList('party:'), loadList('sale:'), loadList('purchase:'), loadList('payment:')]);
    ledgerParties=data[0]; ledgerSales=data[1]; ledgerPurchases=data[2]; ledgerPayments=data[3];
    var cust=ledgerParties.filter(function(p){return p.type==='customer';});
    var supp=ledgerParties.filter(function(p){return p.type==='supplier';});
    document.getElementById('ledgerParty').innerHTML = '<option value="">Select</option>'+
      (cust.length?'<optgroup label="Customers">'+cust.map(function(c){return '<option value="'+c._key+'">'+c.name+'</option>';}).join('')+'</optgroup>':'')+
      (supp.length?'<optgroup label="Suppliers">'+supp.map(function(s){return '<option value="'+s._key+'">'+s.name+'</option>';}).join('')+'</optgroup>':'');
  }

  window.loadLedger = function() {
    var key   = document.getElementById('ledgerParty').value;
    var from  = document.getElementById('ledgerFrom').value;
    var to    = document.getElementById('ledgerTo').value;
    var party = ledgerParties.find(function(p){return p._key===key;});
    if (!party) { document.getElementById('ledgerContent').innerHTML=''; return; }

    function inRange(date){ return (!from||date>=from) && (!to||date<=to); }
    var entries = [];

    if (party.type==='customer') {
      ledgerSales.filter(function(s){return s.customerId===key && inRange(s.date||'');}).forEach(function(s){
        entries.push({date:s.date, desc:'Sale '+(s.invoiceNo||''), debit:Number(s.total||0), credit:Number(s.received||0)});
      });
    } else {
      ledgerPurchases.filter(function(p){return p.supplierId===key && inRange(p.date||'');}).forEach(function(p){
        entries.push({date:p.date, desc:'Purchase '+(p.purchaseNo||''), debit:Number(p.paid||0), credit:Number(p.total||0)});
      });
    }

    ledgerPayments.filter(function(p){return p.partyId===key && inRange(p.date||'');}).forEach(function(p){
      if (party.type==='customer')
        entries.push({date:p.date, desc:'Receipt '+(p.number||'')+' ('+p.method+')', debit:0, credit:Number(p.amount||0)});
      else
        entries.push({date:p.date, desc:'Payment '+(p.number||'')+' ('+p.method+')', debit:Number(p.amount||0), credit:0});
    });

    entries.sort(function(a,b){return (a.date||'').localeCompare(b.date||'');});
    var balance=0;
    entries.forEach(function(e){ balance+=Number(e.debit||0)-Number(e.credit||0); e.balance=balance; });

    document.getElementById('ledgerContent').innerHTML =
      '<div class="card" style="padding:0;overflow:hidden">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border)">'+
          '<div><div class="bold" style="font-size:15px">'+party.name+'</div><div class="text-muted" style="font-size:12px;text-transform:capitalize">'+party.type+'</div></div>'+
          '<div style="text-align:right"><div class="text-muted" style="font-size:11px">Current Balance</div><div class="bold '+((party.balance||0)>0?'text-danger':'text-success')+'" style="font-size:18px">'+fmt(party.balance||0)+'</div></div>'+
        '</div>'+
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Description</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead><tbody>'+
          (!entries.length
            ? '<tr><td colspan="5" class="empty">No transactions in range.</td></tr>'
            : entries.map(function(e){
                return '<tr>'+
                  '<td>'+(e.date||'')+'</td>'+
                  '<td>'+(e.desc||'')+'</td>'+
                  '<td class="r">'+(e.debit>0?fmt(e.debit):'—')+'</td>'+
                  '<td class="r">'+(e.credit>0?fmt(e.credit):'—')+'</td>'+
                  '<td class="r bold '+(e.balance>0?'text-danger':'text-success')+'">'+fmt(e.balance)+'</td>'+
                '</tr>';
              }).join(''))+
        '</tbody></table></div>'+
      '</div>';
  };

  initLedger();
  </script>`;
}

// ============================================================
// PROFIT & LOSS
// ============================================================
function profitLossPage() {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return `
  <div class="page-header">
    <div><div class="page-title">Profit & Loss Statement</div><div class="page-sub">Professional summary for selected period</div></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <div class="form-row" style="grid-template-columns:1fr 1fr">
      <div><label>From</label><input type="date" id="plFrom" value="${from}" onchange="calcPL()"></div>
      <div><label>To</label><input type="date" id="plTo" value="${to}" onchange="calcPL()"></div>
    </div>
  </div>
  <div class="card" style="padding:0;max-width:760px" id="plReport"></div>
  <script>
  var plSales=[], plPurchases=[], plExpenses=[];

  async function initPL() {
    var data = await Promise.all([loadList('sale:'), loadList('purchase:'), loadList('expense:')]);
    plSales=data[0]; plPurchases=data[1]; plExpenses=data[2];
    calcPL();
  }

  window.calcPL = function() {
    var from = document.getElementById('plFrom').value;
    var to   = document.getElementById('plTo').value;
    function inRange(d){ return d>=from && d<=to; }

    var sales     = plSales.filter(function(s){return inRange(s.date||'');});
    var purchases = plPurchases.filter(function(p){return inRange(p.date||'');});
    var expenses  = plExpenses.filter(function(e){return inRange(e.date||'');});

    var revenue   = sales.reduce(function(s,x){return s+(x.total||0);},0);
    var cogs      = purchases.reduce(function(s,x){return s+(x.total||0);},0);
    var gross     = revenue-cogs;
    var operating = expenses.reduce(function(s,e){return s+(e.amount||0);},0);
    var net       = gross-operating;

    var gm = revenue>0?(gross/revenue*100):0;
    var nm = revenue>0?(net/revenue*100):0;

    var byHead = {};
    expenses.forEach(function(e){ var k=e.headName||'Other'; byHead[k]=(byHead[k]||0)+(e.amount||0); });
    var expRows = Object.keys(byHead).length
      ? Object.keys(byHead).sort().map(function(k){ return '<div class="pl-row"><span class="text-muted">'+k+'</span><span>'+fmt(byHead[k])+'</span></div>'; }).join('')
      : '<div class="pl-row text-muted">No expenses in this period.</div>';

    document.getElementById('plReport').innerHTML =
      '<div class="pl-header"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:700">Profit & Loss Statement</div>'+
      '<div class="text-muted" style="font-size:12px;margin-top:4px">'+from+' to '+to+'</div></div>'+
      '<div class="pl-row"><span>Revenue ('+sales.length+' sales)</span><span class="bold">'+fmt(revenue)+'</span></div>'+
      '<div class="pl-row"><span>Cost of Goods Sold</span><span>'+fmt(cogs)+'</span></div>'+
      '<div class="pl-row total" style="font-size:16px"><span>Gross Profit</span><span class="'+(gross>=0?'text-success':'text-danger')+'">'+fmt(gross)+'</span></div>'+
      '<div class="pl-row" style="font-weight:700;margin-top:8px"><span>Operating Expenses</span><span></span></div>'+
      expRows+
      '<div class="pl-row"><span>Total Operating Expenses</span><span>'+fmt(operating)+'</span></div>'+
      '<div class="pl-row total" style="font-size:16px"><strong>Net Profit / (Loss)</strong><strong class="'+(net>=0?'text-success':'text-danger')+'">'+fmt(net)+'</strong></div>'+
      '<div class="pl-row"><span>Gross Margin</span><span>'+gm.toFixed(2)+'%</span></div>'+
      '<div class="pl-row"><span>Net Margin</span><span>'+nm.toFixed(2)+'%</span></div>';
  };

  initPL();
  </script>`;
}

// ============================================================
// DAY DETAILS
// ============================================================
function dayDetailsPage() {
  const today = new Date().toISOString().slice(0, 10);
  return `
  <div class="page-header">
    <div><div class="page-title">Day Details</div><div class="page-sub">Daily snapshot of all transactions</div></div>
  </div>
  <div class="card" style="max-width:340px;margin-bottom:16px">
    <div class="form-group" style="margin:0"><label>Select Date</label><input type="date" id="dayDate" value="${today}" onchange="renderDay()"></div>
  </div>
  <div class="summary-grid" id="daySummary"></div>
  <div style="display:grid;grid-template-columns:1fr;gap:14px">
    <div class="card" id="dayPurchases"></div>
    <div class="card" id="daySales"></div>
    <div class="card" id="dayTransactions"></div>
    <div class="card" id="dayExpenses"></div>
    <div class="card" id="dayBanks"></div>
  </div>
  <script>
  var dayPurchasesData=[], daySalesData=[], dayPaymentsData=[], dayExpensesData=[], dayBanksData=[];

  async function initDay() {
    var data = await Promise.all([loadList('purchase:'), loadList('sale:'), loadList('payment:'), loadList('expense:'), loadList('bank:')]);
    dayPurchasesData=data[0]; daySalesData=data[1]; dayPaymentsData=data[2]; dayExpensesData=data[3]; dayBanksData=data[4];
    renderDay();
  }

  window.renderDay = function() {
    var date = document.getElementById('dayDate').value;
    var purchases = dayPurchasesData.filter(function(p){return p.date===date;});
    var sales     = daySalesData.filter(function(s){return s.date===date;});
    var payments  = dayPaymentsData.filter(function(p){return p.date===date;});
    var expenses  = dayExpensesData.filter(function(e){return e.date===date;});

    var purTotal      = purchases.reduce(function(s,p){return s+(p.total||0);},0);
    var purPaid       = purchases.reduce(function(s,p){return s+(p.paid||0);},0);
    var salesTotal    = sales.reduce(function(s,x){return s+(x.total||0);},0);
    var salesReceived = sales.reduce(function(s,x){return s+(x.received||0);},0);

    var rcCash = payments.filter(function(p){return p.type==='receipt'&&p.method==='cash';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var rcBank = payments.filter(function(p){return p.type==='receipt'&&p.method==='bank';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var pyACash= payments.filter(function(p){return p.type==='payment'&&p.method==='cash';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var pyABank= payments.filter(function(p){return p.type==='payment'&&p.method==='bank';}).reduce(function(s,p){return s+(p.amount||0);},0);
    var expCash= expenses.filter(function(e){return e.method==='cash';}).reduce(function(s,e){return s+(e.amount||0);},0);

    var cashInHand = (rcCash+salesReceived)-(pyACash+purPaid+expCash);

    var bankBal = {};
    dayBanksData.forEach(function(b){ bankBal[b._key]=Number(b.openingBalance||0); });
    dayPaymentsData.filter(function(p){return p.method==='bank'&&p.date<=date;}).forEach(function(p){
      if (!bankBal[p.bankId]) bankBal[p.bankId]=0;
      bankBal[p.bankId]+= p.type==='receipt'?Number(p.amount||0):-Number(p.amount||0);
    });
    dayExpensesData.filter(function(e){return e.method==='bank'&&e.date<=date;}).forEach(function(e){
      if (!bankBal[e.bankId]) bankBal[e.bankId]=0;
      bankBal[e.bankId]-=Number(e.amount||0);
    });
    var totalBank = Object.keys(bankBal).reduce(function(s,k){return s+Number(bankBal[k]||0);},0);

    document.getElementById('daySummary').innerHTML = [
      {label:'Purchase Total',value:fmt(purTotal),color:'var(--primary)'},
      {label:'Sales Total',value:fmt(salesTotal),color:'var(--accent)'},
      {label:'Cash In Hand',value:fmt(cashInHand),color:cashInHand>=0?'var(--accent)':'var(--danger)'},
      {label:'Cash In Banks',value:fmt(totalBank),color:totalBank>=0?'var(--primary)':'var(--danger)'}
    ].map(function(c){return '<div class="summary-card"><div class="label">'+c.label+'</div><div class="value" style="color:'+c.color+'">'+c.value+'</div></div>';}).join('');

    document.getElementById('dayPurchases').innerHTML = '<h3 style="font-size:15px;margin-bottom:10px">Purchases</h3>'+(!purchases.length?'<div class="text-muted">No purchases.</div>':'<div class="table-wrap"><table class="tbl"><thead><tr><th>No</th><th>Supplier</th><th class="r">Total</th><th class="r">Paid</th></tr></thead><tbody>'+purchases.map(function(p){return '<tr><td>'+(p.purchaseNo||'-')+'</td><td>'+(p.supplierName||'')+'</td><td class="r">'+fmt(p.total)+'</td><td class="r">'+fmt(p.paid)+'</td></tr>';}).join('')+'</tbody></table></div>');
    document.getElementById('daySales').innerHTML     = '<h3 style="font-size:15px;margin-bottom:10px">Sales</h3>'+(!sales.length?'<div class="text-muted">No sales.</div>':'<div class="table-wrap"><table class="tbl"><thead><tr><th>No</th><th>Customer</th><th class="r">Total</th><th class="r">Received</th></tr></thead><tbody>'+sales.map(function(s){return '<tr><td>'+(s.invoiceNo||'-')+'</td><td>'+(s.customerName||'')+'</td><td class="r">'+fmt(s.total)+'</td><td class="r">'+fmt(s.received)+'</td></tr>';}).join('')+'</tbody></table></div>');
    document.getElementById('dayTransactions').innerHTML = '<h3 style="font-size:15px;margin-bottom:10px">Receipts & Payments</h3>'+
      '<div class="summary-grid" style="margin-bottom:10px">'+
        '<div class="summary-card"><div class="label">Cash Receipts</div><div class="value" style="font-size:18px;color:var(--accent)">'+fmt(rcCash)+'</div></div>'+
        '<div class="summary-card"><div class="label">Bank Receipts</div><div class="value" style="font-size:18px;color:var(--primary)">'+fmt(rcBank)+'</div></div>'+
        '<div class="summary-card"><div class="label">Cash Payments</div><div class="value" style="font-size:18px;color:var(--danger)">'+fmt(pyACash)+'</div></div>'+
        '<div class="summary-card"><div class="label">Bank Payments</div><div class="value" style="font-size:18px;color:var(--warning)">'+fmt(pyABank)+'</div></div>'+
      '</div>'+
      (!payments.length?'<div class="text-muted">No receipt/payment transactions.</div>':'<div class="table-wrap"><table class="tbl"><thead><tr><th>No</th><th>Type</th><th>Party</th><th>Method</th><th class="r">Amount</th></tr></thead><tbody>'+payments.map(function(p){return '<tr><td>'+(p.number||'-')+'</td><td style="text-transform:capitalize">'+p.type+'</td><td>'+(p.partyName||'')+'</td><td>'+p.method+(p.bankName?' ('+p.bankName+')':'')+'</td><td class="r">'+fmt(p.amount)+'</td></tr>';}).join('')+'</tbody></table></div>');
    document.getElementById('dayExpenses').innerHTML  = '<h3 style="font-size:15px;margin-bottom:10px">Expenses</h3>'+(!expenses.length?'<div class="text-muted">No expenses.</div>':'<div class="table-wrap"><table class="tbl"><thead><tr><th>No</th><th>Head</th><th>Method</th><th class="r">Amount</th></tr></thead><tbody>'+expenses.map(function(e){return '<tr><td>'+(e.expenseNo||'-')+'</td><td>'+(e.headName||'')+'</td><td>'+e.method+(e.bankName?' ('+e.bankName+')':'')+'</td><td class="r">'+fmt(e.amount)+'</td></tr>';}).join('')+'</tbody></table></div>');
    document.getElementById('dayBanks').innerHTML     = '<h3 style="font-size:15px;margin-bottom:10px">Bank Balances (as of date)</h3>'+(dayBanksData.length?'<div class="table-wrap"><table class="tbl"><thead><tr><th>Bank</th><th class="r">Balance</th></tr></thead><tbody>'+dayBanksData.map(function(b){return '<tr><td>'+(b.name||'')+'</td><td class="r">'+fmt(bankBal[b._key]||0)+'</td></tr>';}).join('')+'</tbody></table></div>':'<div class="text-muted">No bank accounts.</div>');
  };

  initDay();
  </script>`;
}

// ============================================================
// ADMIN
// ============================================================
function adminPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Admin Panel</div><div class="page-sub">System settings and quick checks</div></div>
  </div>
  <div class="card" style="max-width:560px">
    <h3 style="font-size:15px;font-weight:600;margin-bottom:12px">License Info</h3>
    <div id="licenseInfo" class="text-muted">Loading...</div>
    <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
    <h3 style="font-size:15px;font-weight:600;margin-bottom:12px">Quick Actions</h3>
    <button class="btn btn-outline" onclick="location.reload()">🔄 Refresh</button>
  </div>
  <script>
  (async function() {
    var r = await fetch('/api/license-info');
    var d = await r.json();
    document.getElementById('licenseInfo').innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">'+
        '<div><div class="text-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:2px">Status</div><span class="badge '+(d.status==='Active'?'badge-cash':'badge-bank')+'">'+d.status+'</span></div>'+
        '<div><div class="text-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:2px">Expires</div><div class="bold">'+d.expiry+'</div></div>'+
        '<div><div class="text-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:2px">Days Left</div><div class="bold '+(d.days<30?'text-danger':'text-success')+'">'+d.days+'</div></div>'+
      '</div>';
  })();
  </script>`;
}
