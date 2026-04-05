// ============================================================
// BizManager — Cloudflare Worker (Single File) - FIXED VERSION
// Deploy via Cloudflare Worker Web Editor
// KV Namespace binding: DATA_STORE
// ============================================================

const PIN = "1234";
const MASTER_KEY = "4321";
const LICENSE_EXPIRE = "2028-12-31";
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

    .btn-sm {
      padding: 6px 12px;
      font-size: 12px;
      border-radius: 6px;
    }

    .btn {
      transition: all 0.2s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.08);
    }
  @media (max-width: 600px) {
    .tbl thead {
      display: none;
    }

    .tbl tr {
      display: block;
      border-bottom: 1px solid #eee;
      margin-bottom: 10px;
    }

    .tbl td {
      display: flex;
      justify-content: space-between;
      padding: 8px;
    }

    .tbl td::before {
      font-weight: bold;
      color: #6b7280;
    }

    .tbl td:nth-child(1)::before { content: "Name"; }
    .tbl td:nth-child(2)::before { content: "SKU"; }
    .tbl td:nth-child(3)::before { content: "Buy"; }
    .tbl td:nth-child(4)::before { content: "Sell"; }
    .tbl td:nth-child(5)::before { content: "Stock"; }
    .tbl td:nth-child(6)::before { content: "Actions"; }
  }
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
  var products = [];
  var editKey = null;

  function generateSKU(name) {
    var clean = String(name || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .slice(0, 4) || 'PRD';

    var rand = Math.random().toString(36).slice(2,6).toUpperCase();

    return clean + '-' + rand;
  }

  // LOAD
  async function loadProducts() {
    try {
      console.log('Loading products...');

      var res = await fetch('/api/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'product:' })
      });

      var data = await res.json();

      console.log('Loaded:', data);

      products = Array.isArray(data) ? data : [];

      renderProducts(products);

    } catch (err) {
      console.error(err);
      alert('Load failed');
    }
  }

  // RENDER
  function renderProducts(list) {
    var body = document.getElementById('productBody');
    if (!body) return;

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="6">No products</td></tr>';
      return;
    }

    var html = '';

    for (var i = 0; i < list.length; i++) {
      var p = list[i];

    html += '<tr>' +
      '<td><b>' + (p.name || '') + '</b></td>' +
      '<td>' + (p.sku || '') + '</td>' +
      '<td>' + (p.purchasePrice || 0) + '</td>' +
      '<td>' + (p.salePrice || 0) + '</td>' +
      '<td>' + (p.stock || 0) + '</td>' +
      '<td>' +
        '<div style="display:flex;gap:6px;justify-content:flex-end">' +
          '<button data-edit="' + p._key + '" class="btn btn-outline btn-sm">✏️</button>' +
          '<button data-key="' + p._key + '" class="btn btn-danger btn-sm delBtn">🗑</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
    }

    body.innerHTML = html;
  }

  document.addEventListener('click', function(e) {

    // DELETE
    if (e.target.classList.contains('delBtn')) {
      var el = e.target.closest('[data-key]');
            if (!el) return;
                  var key = el.getAttribute('data-key');
      deleteProduct(key);
    }

    // EDIT
    if (e.target.hasAttribute('data-edit')) {
      var key = e.target.getAttribute('data-edit');
      openEditProduct(key);
    }

  });

  // SAVE
  window.saveProduct = async function () {
    var name = document.getElementById('pName').value.trim();

    if (!name) {
      alert('Enter product name');
      return;
    }

    var skuInput = document.getElementById('pSku');

    var sku = skuInput.value.trim();
    if (!sku) {
      sku = generateSKU(name);
      skuInput.value = sku;
    }

    var data = {
      name: name,
      sku: sku,
      unit: document.getElementById('pUnit').value || 'pcs',
      purchasePrice: Number(document.getElementById('pBuy').value || 0),
      salePrice: Number(document.getElementById('pSell').value || 0),
      stock: Number(document.getElementById('pStock').value || 0)
    };

    var payload;

    if (editKey) {
      payload = {
        key: editKey,
        data: data
      };
    } else {
      payload = {
        prefix: 'product:',
        data: data
      };
    }

    var res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    var json = await res.json();

    if (!json || !json.key) {
      alert('Save failed');
      return;
    }

    editKey = null;

    closeModal('addProduct');
    loadProducts();
  };

  // DELETE
  window.deleteProduct = async function (key) {
    if (!confirm('Delete?')) return;

    await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key })
    });

    loadProducts();
  };

  // SEARCH
  window.filterProducts = function (q) {
    var t = String(q || '').toLowerCase();

    var filtered = products.filter(function (p) {
      return (p.name || '').toLowerCase().includes(t) ||
            (p.sku || '').toLowerCase().includes(t);
    });

    renderProducts(filtered);
  };

  function openEditProduct(key) {
    var p = products.find(function(x) {
      return x._key === key;
    });

    if (!p) {
      alert('Product not found');
      return;
    }

    editKey = key;

    document.getElementById('pName').value = p.name || '';
    document.getElementById('pSku').value = p.sku || '';
    document.getElementById('pUnit').value = p.unit || 'pcs';
    document.getElementById('pBuy').value = p.purchasePrice || 0;
    document.getElementById('pSell').value = p.salePrice || 0;
    document.getElementById('pStock').value = p.stock || 0;

    openModal('addProduct');
  }

  // INIT
  window.addEventListener('load', loadProducts);
  </script>`;
}

// ============================================================
// CUSTOMERS & SUPPLIERS
// ============================================================
function partiesPage() {
  return `
  <div class="page-header">
    <div><div class="page-title">Customers & Suppliers</div><div class="page-sub">Manage business contacts</div></div>
    <button class="btn btn-primary" id="addPartyBtn">➕ Add</button>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="customer">Customers</button>
    <button class="tab" data-tab="supplier">Suppliers</button>
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

  document.getElementById('addPartyBtn').onclick = function(){
    openAddParty();
  };

  document.addEventListener('click', function(e){

    if (e.target.classList.contains('tab')) {
      var type = e.target.getAttribute('data-tab');

      partyTab = type;

      document.querySelectorAll('.tab').forEach(function(x){
        x.classList.remove('active');
      });

      e.target.classList.add('active');

      renderParties();
    }

  });

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
            '<td class="r"><button class="btn btn-outline btn-sm editPartyBtn" data-key="' + p._key + '">✏️</button></td>'+
          '</tr>';
        }).join('');
  }

  window.filterParties = function(q) {
    var t = normalize(q);
    renderParties(allParties.filter(function(p){
      return p.type===partyTab && (normalize(p.name).includes(t)||normalize(p.phone).includes(t)||normalize(p.address).includes(t));
    }));
  };

  document.addEventListener('click', function(e){

    if (e.target.classList.contains('editPartyBtn')) {
      var key = e.target.getAttribute('data-key');
      editParty(key);
    }

  });

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
// PURCHASES MODULE
// ============================================================
function purchasesPage() {
  return `
  <div class="page-header">
    <div>
      <div class="page-title">Purchases</div>
      <div class="page-sub">Purchase products from suppliers</div>
    </div>
    <button class="btn btn-primary" onclick="window.openPurchaseModal()">➕ New Purchase</button>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Date</th>
            <th>Purchase #</th>
            <th>Supplier</th>
            <th class="r">Items</th>
            <th class="r">Total</th>
            <th class="r">Paid</th>
            <th class="r">Due</th>
            <th class="r">Actions</th>
          </tr>
        </thead>
        <tbody id="purchaseBody"></tbody>
      </table>
    </div>
  </div>

  <div class="modal-overlay" id="addPurchase">
    <div class="modal">
      <h3 id="purModalTitle">New Purchase</h3>
      <div class="form-row">
        <div>
          <label>Date</label>
          <input type="date" id="purDate">
        </div>
        <div>
          <label>Purchase Number</label>
          <input id="purNo" readonly>
        </div>
      </div>
      <div class="form-group">
        <label>Supplier</label>
        <select id="purSupplier"></select>
      </div>
      <datalist id="purProductOptions"></datalist>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px">
        <span style="font-weight:600;font-size:13px">Items</span>
        <button class="btn btn-outline btn-sm" onclick="window.addPurItem()">➕ Add Item</button>
      </div>
      
      <div id="purItems"></div>
      
      <div class="form-row" style="margin-top:12px">
        <div class="form-row">
          <div>
            <label>Discount</label>
            <input type="number" id="purDiscount" value="0" oninput="window.calcPurTotal()">
          </div>
          <div>
            <label>Extra</label>
            <input type="number" id="purExtra" value="0" oninput="window.calcPurTotal()">
          </div>
        </div>
        <div class="form-row">
          <div>
            <label>VAT Type</label>
            <select id="purVatType" onchange="window.calcPurTotal()">
              <option value="percent">%</option>
              <option value="flat">Flat</option>
            </select>
          </div>
          <div>
            <label>VAT</label>
            <input type="number" id="purVat" value="0" oninput="window.calcPurTotal()">
          </div>
        </div>
        <div>
          <label>Total</label>
          <div id="purTotal" style="font-size:18px;font-weight:700">0</div>
        </div>
        <div>
          <label>Paid</label>
          <input type="number" id="purPaid" placeholder="0">
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-outline" onclick="closeModal('addPurchase')">Cancel</button>
        <button class="btn btn-primary" onclick="window.savePurchase()">Save Purchase</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="viewPurchase">
    <div class="modal" style="max-width:800px">
      <h3>Purchase Invoice</h3>
      <div id="purchaseInvoiceContent"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
        <button class="btn btn-outline" onclick="closeModal('viewPurchase')">Close</button>
        <button class="btn btn-primary" onclick="window.printPurchase()">🖨 Print</button>
      </div>
    </div>
  </div>

  <script>
  var editKey = null;
  var purProducts = [];
  var purSuppliers = [];
  var purItems = [];
  var documentData = [];

  window.initPurchases = async function() {
    var data = await Promise.all([loadList('purchase:'), loadList('product:'), loadList('party:')]);
    documentData = data[0] || [];
    purProducts = data[1] || [];
    purSuppliers = (data[2] || []).filter(p => p.type === 'supplier');

    document.getElementById('purSupplier').innerHTML = '<option value="">Select Supplier</option>' +
      purSuppliers.map(s => '<option value="'+s._key+'">'+s.name+'</option>').join('');
    
    document.getElementById('purProductOptions').innerHTML = purProducts.map(p => '<option value="'+p.name+'"></option>').join('');
    renderPurchaseTable();
  };

  function renderPurchaseTable() {
    var sorted = documentData.slice().sort((a,b) => (b.date||'').localeCompare(a.date||''));
    document.getElementById('purchaseBody').innerHTML = !sorted.length
      ? '<tr><td colspan="8" class="empty">No purchases yet.</td></tr>'
      : sorted.map(p => '<tr><td>'+(p.date||'')+'</td><td><span class="clickable viewBtn" data-key="'+p._key+'">'+(p.purchaseNo||'-')+'</span></td><td>'+(p.supplierName||'')+'</td><td class="r">'+((p.items||[]).length)+'</td><td class="r bold">'+fmt(p.total)+'</td><td class="r">'+fmt(p.paid)+'</td><td class="r">'+fmt((p.total||0)-(p.paid||0))+'</td><td class="r"><button class="btn btn-outline btn-sm editPurchaseBtn" data-key="'+p._key+'">✏️</button></td></tr>').join('');
  }

  window.openPurchaseModal = function() {
    editKey = null;
    document.getElementById('purModalTitle').innerText = "New Purchase";
    document.getElementById('purDate').value = todayISO();
    document.getElementById('purNo').value = txnNo('PUR');
    document.getElementById('purSupplier').value = '';
    document.getElementById('purPaid').value = '';
    document.getElementById('purDiscount').value = 0;
    document.getElementById('purExtra').value = 0;
    document.getElementById('purVat').value = 0;
    purItems = [];
    window.addPurItem();
    openModal('addPurchase');
  };

  window.addPurItem = function() {
    purItems.push({ productKey:'', productName:'', qty:1, rate:0, amount:0 });
    window.renderPurItems();
  };

  window.renderPurItems = function() {
    var html = purItems.map((item, i) => \`
      <div class="form-row" style="grid-template-columns:1fr 70px 100px 100px 36px;align-items:end;margin-bottom:8px">
        <div><input list="purProductOptions" placeholder="Product" value="\${item.productName}" oninput="window.purUpdateField(\${i}, 'productName', this.value)"></div>
        <div><input type="number" value="\${item.qty}" oninput="window.purUpdateField(\${i}, 'qty', this.value)"></div>
        <div><input type="number" value="\${item.rate}" oninput="window.purUpdateField(\${i}, 'rate', this.value)"></div>
        <div id="purItemAmt_\${i}" style="font-weight:600;padding:10px 0;text-align:right">\${fmt(item.amount)}</div>
        <div><button class="btn btn-danger btn-sm" onclick="window.purRemove(\${i})">✕</button></div>
      </div>\`).join('');
    document.getElementById('purItems').innerHTML = html;
    window.calcPurTotal();
  };

  window.purUpdateField = function(idx, field, val) {
    if (field === 'productName') {
      purItems[idx].productName = val;
      var found = purProducts.find(p => normalize(p.name) === normalize(val));
      if (found) {
        purItems[idx].productKey = found._key;
        purItems[idx].rate = Number(found.purchasePrice || 0);
        window.renderPurItems(); 
        return;
      }
    } else {
      purItems[idx][field] = Number(val);
    }
    purItems[idx].amount = purItems[idx].qty * purItems[idx].rate;
    if(document.getElementById('purItemAmt_'+idx)) document.getElementById('purItemAmt_'+idx).textContent = fmt(purItems[idx].amount);
    window.calcPurTotal();
  };

  window.calcPurTotal = function() {
    var subtotal = purItems.reduce((s, i) => s + (i.amount || 0), 0);
    var discount = Number(document.getElementById('purDiscount').value || 0);
    var extra = Number(document.getElementById('purExtra').value || 0);
    var vat = Number(document.getElementById('purVat').value || 0);
    var vatType = document.getElementById('purVatType').value;
    var total = subtotal - discount + extra;
    total += (vatType === 'percent') ? (total * vat / 100) : vat;
    document.getElementById('purTotal').textContent = fmt(total);
    return total;
  };

  window.purRemove = function(idx) {
    purItems.splice(idx, 1);
    if(!purItems.length) purItems.push({ productKey:'', productName:'', qty:1, rate:0, amount:0 });
    window.renderPurItems();
  };

  window.viewPurchase = function(key) {
    var p = documentData.find(x => x._key === key);
    if (!p) return;
    var subtotal = (p.items || []).reduce((s, i) => s + (i.amount || 0), 0);
    var base = subtotal - (p.discount || 0) + (p.extra || 0);
    var vatAmt = (p.vatType === 'percent') ? (base * (p.vat || 0) / 100) : (p.vat || 0);
    var rows = (p.items || []).map((it, i) => '<tr><td>'+(i+1)+'</td><td>'+it.productName+'</td><td class="r">'+fmt(it.qty)+'</td><td class="r">'+fmt(it.rate)+'</td><td class="r">'+fmt(it.amount)+'</td></tr>').join('');

    document.getElementById('purchaseInvoiceContent').innerHTML = \`
      <div id="purchasePrintArea">
        <div style="display:flex;justify-content:space-between;margin-bottom:15px">
          <div><h2 style="margin:0">PURCHASE INVOICE</h2><b>No:</b> \${p.purchaseNo}</div>
          <div style="text-align:right"><b>Date:</b> \${p.date}<br><b>Supplier:</b> \${p.supplierName}</div>
        </div>
        <table class="tbl" style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="background:#f4f4f4"><th>#</th><th style="text-align:left">Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amt</th></tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
        <div style="display:flex;justify-content:flex-end;margin-top:15px">
          <div style="width:240px;line-height:1.6">
            <div style="display:flex;justify-content:space-between"><span>Subtotal:</span><span>\${fmt(subtotal)}</span></div>
            <div style="display:flex;justify-content:space-between;color:red"><span>Discount:</span><span>-\${fmt(p.discount)}</span></div>
            <div style="display:flex;justify-content:space-between"><span>Extra:</span><span>+\${fmt(p.extra)}</span></div>
            <div style="display:flex;justify-content:space-between"><span>VAT (\${p.vatType=='percent'?p.vat+'%':'Flat'}):</span><span>+\${fmt(vatAmt)}</span></div>
            <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:16px;border-top:1px solid #ddd;margin-top:5px"><span>Total:</span><span>\${fmt(p.total)}</span></div>
            <div style="display:flex;justify-content:space-between;color:green"><span>Paid:</span><span>\${fmt(p.paid)}</span></div>
            <div style="display:flex;justify-content:space-between;border-top:1px dashed #ccc"><span>Balance:</span><span>\${fmt(p.total - p.paid)}</span></div>
          </div>
        </div>
      </div>\`;
    openModal('viewPurchase');
  };

  // ✅ PRINT FUNCTION ADDED
  window.printPurchase = function() {
    const content = document.getElementById('purchasePrintArea').innerHTML;
    const win = window.open('', '_blank');
    win.document.write(\`
      <html>
        <head>
          <title>Print Purchase</title>
          <style>
            body { font-family: sans-serif; padding: 30px; }
            .tbl { width: 100%; border-collapse: collapse; margin-top: 20px; }
            .tbl th, .tbl td { border: 1px solid #eee; padding: 10px; text-align: left; }
            .r { text-align: right; }
            h2 { color: #333; }
            span { font-size: 14px; }
          </style>
        </head>
        <body>\${content}</body>
      </html>
    \`);
    win.document.close();
    setTimeout(() => {
      win.print();
      win.close();
    }, 500);
  };

  window.savePurchase = async function() {
    var supplierKey = document.getElementById('purSupplier').value;
    var supplier = purSuppliers.find(s => s._key === supplierKey);
    if (!supplier) return alert('Select supplier');
    var validItems = purItems.filter(i => i.productKey && i.qty > 0);
    if (!validItems.length) return alert('Add valid products');
    var total = window.calcPurTotal();
    var paid = Number(document.getElementById('purPaid').value || 0);

    if (editKey) {
      var old = documentData.find(x => x._key === editKey);
      if (old) {
        for (let it of old.items) {
          let p = purProducts.find(x => x._key === it.productKey);
          if (p) { p.stock = (Number(p.stock) || 0) - Number(it.qty); await saveByKey(p._key, cleanForSave(p)); }
        }
      }
    }

    var payload = {
      date: document.getElementById('purDate').value,
      purchaseNo: document.getElementById('purNo').value,
      supplierId: supplier._key, supplierName: supplier.name,
      items: validItems, 
      discount: Number(document.getElementById('purDiscount').value),
      extra: Number(document.getElementById('purExtra').value),
      vat: Number(document.getElementById('purVat').value),
      vatType: document.getElementById('purVatType').value,
      total: total, paid: paid
    };

    var res = editKey ? await saveByKey(editKey, payload) : await saveItem('purchase:', payload);
    if (res) {
      for (let it of validItems) {
        let p = purProducts.find(x => x._key === it.productKey);
        if (p) { p.stock = (Number(p.stock) || 0) + Number(it.qty); await saveByKey(p._key, cleanForSave(p)); }
      }
      closeModal('addPurchase');
      window.initPurchases();
    }
  };

  window.editPurchase = function(key) {
    var p = documentData.find(x => x._key === key);
    if (!p) return;
    editKey = key;
    document.getElementById('purModalTitle').innerText = "Edit Purchase";
    openModal('addPurchase');
    document.getElementById('purDate').value = p.date;
    document.getElementById('purNo').value = p.purchaseNo;
    document.getElementById('purSupplier').value = p.supplierId;
    document.getElementById('purPaid').value = p.paid;
    document.getElementById('purDiscount').value = p.discount || 0;
    document.getElementById('purExtra').value = p.extra || 0;
    document.getElementById('purVat').value = p.vat || 0;
    document.getElementById('purVatType').value = p.vatType || 'percent';
    purItems = JSON.parse(JSON.stringify(p.items));
    window.renderPurItems();
  };

  document.addEventListener('click', function(e) {
    var key = e.target.getAttribute('data-key');
    if (e.target.classList.contains('viewBtn')) window.viewPurchase(key);
    if (e.target.classList.contains('editPurchaseBtn')) window.editPurchase(key);
  });

  window.initPurchases();
  </script>`;
}
// ============================================================
// SALES MODULE (Fixed: Stock Count & Stock-Only Filter)
// ============================================================
function salesPage() {
  return `
  <div class="page-header">
    <div>
      <div class="page-title">Sales</div>
      <div class="page-sub">Manage invoices and customer credit</div>
    </div>
    <button class="btn btn-primary" onclick="window.openSaleModal()">➕ New Sale</button>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Date</th>
            <th>Invoice #</th>
            <th>Customer</th>
            <th class="r">Total</th>
            <th class="r">Paid</th>
            <th class="r">Due</th>
            <th class="r">Actions</th>
          </tr>
        </thead>
        <tbody id="saleBody"></tbody>
      </table>
    </div>
  </div>

  <div class="modal-overlay" id="saleModal">
    <div class="modal" style="max-width:750px">
      <h3 id="saleModalTitle">New Sale</h3>
      <input type="hidden" id="saleEditKey">
      
      <div class="form-row">
        <div>
          <label>Date</label>
          <input type="date" id="saleDate">
        </div>
        <div>
          <label>Invoice Number</label>
          <input id="saleNo" readonly>
        </div>
      </div>

      <div class="form-group">
        <label>Customer</label>
        <select id="saleCustomer"></select>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px">
        <span style="font-weight:600;font-size:13px">Items</span>
        <button class="btn btn-outline btn-sm" onclick="window.addSaleItem()">➕ Add Item</button>
      </div>
      
      <div id="saleItems"></div>

      <div class="form-row" style="margin-top:15px; grid-template-columns: 1fr 1fr 1fr;">
        <div>
          <label>Discount</label>
          <div style="display:flex; gap:4px">
            <select id="saleDiscountType" style="width:70px" onchange="window.calcSaleTotal()">
              <option value="percent">%</option>
              <option value="flat">Flat</option>
            </select>
            <input type="number" id="saleDiscount" value="0" oninput="window.calcSaleTotal()">
          </div>
        </div>
        <div>
          <label>Extra Charges</label>
          <input type="number" id="saleExtra" value="0" oninput="window.calcSaleTotal()">
        </div>
        <div>
          <label>VAT</label>
          <div style="display:flex; gap:4px">
            <select id="saleVatType" style="width:70px" onchange="window.calcSaleTotal()">
              <option value="percent">%</option>
              <option value="flat">Flat</option>
            </select>
            <input type="number" id="saleVat" value="0" oninput="window.calcSaleTotal()">
          </div>
        </div>
      </div>

      <div class="form-row" style="margin-top:10px; grid-template-columns: 1fr 1fr 1fr;">
        <div>
          <label>AIT</label>
          <div style="display:flex; gap:4px">
            <select id="saleAitType" style="width:70px" onchange="window.calcSaleTotal()">
              <option value="percent">%</option>
              <option value="flat">Flat</option>
            </select>
            <input type="number" id="saleAit" value="0" oninput="window.calcSaleTotal()">
          </div>
        </div>
        <div>
          <label>Paid Amount</label>
          <input type="number" id="salePaid" placeholder="0">
        </div>
        <div>
          <label>Payment Method</label>
          <select id="saleMethod" onchange="window.toggleBankView(this.value)">
            <option value="cash">💵 Cash</option>
            <option value="bank">🏦 Bank</option>
          </select>
        </div>
      </div>

      <div id="bankWrap" class="form-group" style="display:none; margin-top:10px">
        <label>Select Bank Account</label>
        <select id="saleBank"></select>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; background:#f0f7ff; padding:15px; border-radius:8px; margin-top:20px">
        <div>
           <span style="font-size:12px; color:#666">Grand Total</span>
           <div id="saleTotal" style="font-size:24px; font-weight:bold; color:#1e40af">0</div>
        </div>
        <div style="display:flex; gap:8px">
          <button class="btn btn-outline" onclick="closeModal('saleModal')">Cancel</button>
          <button class="btn btn-primary" onclick="window.saveSale()">Save Invoice</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="saleView">
    <div class="modal" style="max-width:800px">
      <div id="saleInvoice"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:15px">
        <button class="btn btn-outline" onclick="closeModal('saleView')">Close</button>
        <button class="btn btn-primary" onclick="window.printSale()">🖨 Print</button>
      </div>
    </div>
  </div>

  <script>
  var saleItems = [];
  var products = [];
  var customers = [];
  var sales = [];
  var banks = [];

  window.initSales = async function() {
    let d = await Promise.all([loadList('sale:'), loadList('product:'), loadList('party:'), loadList('bank:')]);
    sales = d[0] || [];
    products = d[1] || [];
    customers = (d[2] || []).filter(x => x.type === 'customer');
    banks = d[3] || [];

    document.getElementById('saleCustomer').innerHTML = '<option value="">Select Customer</option>' +
      customers.map(c => '<option value="'+c._key+'">'+c.name+'</option>').join('');
    document.getElementById('saleBank').innerHTML = banks.map(b => '<option value="'+b._key+'">'+b.name+'</option>').join('');

    renderSalesTable();
  };

  function renderSalesTable() {
    var sorted = sales.slice().sort((a,b) => (b.date||'').localeCompare(a.date||''));
    document.getElementById('saleBody').innerHTML = sorted.map(s => \`
      <tr>
        <td>\${s.date}</td>
        <td><span class="clickable" onclick="window.viewSale('\${s._key}')">\${s.invoiceNo}</span></td>
        <td>\${s.customerName}</td>
        <td class="r">\${fmt(s.total)}</td>
        <td class="r">\${fmt(s.paid)}</td>
        <td class="r bold" style="color:\${(s.total-s.paid)>0?'#b91c1c':'#15803d'}">\${fmt(s.total - s.paid)}</td>
        <td class="r">
          <button class="btn btn-outline btn-sm" onclick="window.editSale('\${s._key}')">✏️</button>
        </td>
      </tr>\`).join('');
  }

  window.openSaleModal = function() {
    document.getElementById('saleEditKey').value = '';
    document.getElementById('saleModalTitle').innerText = "New Sale";
    document.getElementById('saleDate').value = todayISO();
    document.getElementById('saleNo').value = txnNo('SAL');
    document.getElementById('salePaid').value = '';
    document.getElementById('saleDiscount').value = 0;
    document.getElementById('saleExtra').value = 0;
    document.getElementById('saleVat').value = 0;
    document.getElementById('saleAit').value = 0;
    saleItems = [];
    window.addSaleItem();
    openModal('saleModal');
  };

  window.addSaleItem = function() {
    saleItems.push({productKey:'', productName:'', qty:1, rate:0, amount:0});
    window.renderItems();
  };

  window.removeSaleItem = function(idx) {
    saleItems.splice(idx, 1);
    if(saleItems.length === 0) window.addSaleItem();
    else window.renderItems();
  };

  // ✅ FIXED: Now filters for stock > 0 AND shows the count beside the name
  window.renderItems = function() {
    var html = saleItems.map((it, i) => \`
      <div class="form-row" style="grid-template-columns:1fr 70px 100px 100px 36px; align-items:end; margin-bottom:8px">
        <select onchange="window.updateSaleRow(\${i}, 'productKey', this.value)">
          <option value="">Select Product</option>
          \${products
            .filter(p => p.stock > 0 || p._key === it.productKey)
            .map(p => '<option value="'+p._key+'" '+(it.productKey==p._key?'selected':'')+'>'+p.name+' (Stock: '+(p.stock||0)+')</option>')
            .join('')}
        </select>
        <input type="number" value="\${it.qty}" oninput="window.updateSaleRow(\${i}, 'qty', this.value)">
        <input type="number" value="\${it.rate}" oninput="window.updateSaleRow(\${i}, 'rate', this.value)">
        <div id="saleItemAmt_\${i}" style="text-align:right; font-weight:600; padding:10px 0">\${fmt(it.amount)}</div>
        <button class="btn btn-danger btn-sm" onclick="window.removeSaleItem(\${i})">✕</button>
      </div>\`).join('');
    document.getElementById('saleItems').innerHTML = html;
    window.calcSaleTotal();
  };

  window.updateSaleRow = function(idx, field, val) {
    if (field === 'productKey') {
      let p = products.find(x => x._key === val);
      if (p) {
        saleItems[idx].productKey = val;
        saleItems[idx].productName = p.name;
        saleItems[idx].rate = p.salePrice || 0;
      }
      window.renderItems(); 
      return;
    }
    saleItems[idx][field] = Number(val);
    saleItems[idx].amount = saleItems[idx].qty * saleItems[idx].rate;
    if(document.getElementById('saleItemAmt_'+idx)) document.getElementById('saleItemAmt_'+idx).textContent = fmt(saleItems[idx].amount);
    window.calcSaleTotal();
  };

  window.calcSaleTotal = function() {
    let sub = saleItems.reduce((s,i) => s + (i.amount || 0), 0);
    let dVal = Number(document.getElementById('saleDiscount').value || 0);
    let dType = document.getElementById('saleDiscountType').value;
    let discAmt = (dType === 'percent') ? (sub * dVal / 100) : dVal;
    let extra = Number(document.getElementById('saleExtra').value || 0);
    let base = sub - discAmt + extra;
    let vVal = Number(document.getElementById('saleVat').value || 0);
    let vType = document.getElementById('saleVatType').value;
    let vatAmt = (vType === 'percent') ? (base * vVal / 100) : vVal;
    let aVal = Number(document.getElementById('saleAit').value || 0);
    let aType = document.getElementById('saleAitType').value;
    let aitAmt = (aType === 'percent') ? (base * aVal / 100) : aVal;
    let total = base + vatAmt + aitAmt;
    document.getElementById('saleTotal').innerText = fmt(total);
    return total;
  };

  window.toggleBankView = function(val) {
    document.getElementById('bankWrap').style.display = (val === 'bank') ? 'block' : 'none';
  };

  window.editSale = function(key) {
    let s = sales.find(x => x._key === key);
    if (!s) return;
    document.getElementById('saleEditKey').value = s._key;
    document.getElementById('saleModalTitle').innerText = "Edit Sale";
    document.getElementById('saleDate').value = s.date;
    document.getElementById('saleNo').value = s.invoiceNo;
    document.getElementById('saleCustomer').value = s.customerId;
    document.getElementById('salePaid').value = s.paid;
    document.getElementById('saleDiscount').value = s.discount || 0;
    document.getElementById('saleDiscountType').value = s.discountType || 'percent';
    document.getElementById('saleExtra').value = s.extra || 0;
    document.getElementById('saleVat').value = s.vat || 0;
    document.getElementById('saleVatType').value = s.vatType || 'percent';
    document.getElementById('saleAit').value = s.ait || 0;
    document.getElementById('saleAitType').value = s.aitType || 'percent';
    document.getElementById('saleMethod').value = s.method || 'cash';
    window.toggleBankView(s.method);
    if(s.bankKey) document.getElementById('saleBank').value = s.bankKey;
    saleItems = JSON.parse(JSON.stringify(s.items));
    window.renderItems();
    openModal('saleModal');
  };

  window.viewSale = function(key) {
    let s = sales.find(x => x._key === key);
    if (!s) return;
    let sub = s.items.reduce((sum, i) => sum + (i.amount || 0), 0);
    let discAmt = (s.discountType === 'percent') ? (sub * (s.discount||0) / 100) : (s.discount||0);
    let baseForTax = sub - discAmt + (s.extra || 0);
    let vatAmt = (s.vatType === 'percent') ? (baseForTax * (s.vat||0) / 100) : (s.vat||0);
    let aitAmt = (s.aitType === 'percent') ? (baseForTax * (s.ait||0) / 100) : (s.ait||0);

    let rows = s.items.map((it, i) => \`<tr><td>\${i+1}</td><td>\${it.productName}</td><td class="r">\${it.qty}</td><td class="r">\${fmt(it.rate)}</td><td class="r">\${fmt(it.amount)}</td></tr>\`).join('');

    document.getElementById('saleInvoice').innerHTML = \`
      <div id="printArea">
        <div style="display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:15px">
          <div><h2 style="margin:0">INVOICE</h2><b>No:</b> \${s.invoiceNo}</div>
          <div style="text-align:right"><b>Date:</b> \${s.date}<br><b>Customer:</b> \${s.customerName}</div>
        </div>
        <table class="tbl" style="width:100%; border-collapse:collapse">
          <thead><tr style="background:#f4f4f4"><th>#</th><th>Product</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>
        <div style="display:flex;justify-content:flex-end;margin-top:20px">
          <div style="width:300px; line-height:1.8">
            <div style="display:flex;justify-content:space-between"><span>Subtotal:</span><span>\${fmt(sub)}</span></div>
            <div style="display:flex;justify-content:space-between; color:red"><span>Discount:</span><span>-\${fmt(discAmt)}</span></div>
            <div style="display:flex;justify-content:space-between; border-top:1px solid #eee"><span>VAT:</span><span>+\${fmt(vatAmt)}</span></div>
            <div style="display:flex;justify-content:space-between"><span>AIT:</span><span>+\${fmt(aitAmt)}</span></div>
            <div style="display:flex;justify-content:space-between; font-weight:bold; font-size:1.2em; border-top:2px solid #333; margin-top:5px"><span>Grand Total:</span><span>\${fmt(s.total)}</span></div>
            <div style="display:flex;justify-content:space-between; color:green"><span>Paid:</span><span>\${fmt(s.paid)}</span></div>
            <div style="display:flex;justify-content:space-between; border-top:1px dashed #666"><span>Balance Due:</span><span>\${fmt(s.total - s.paid)}</span></div>
          </div>
        </div>
      </div>\`;
    openModal('saleView');
  };

  window.saveSale = async function() {
    let editKey = document.getElementById('saleEditKey').value;
    let custKey = document.getElementById('saleCustomer').value;
    let cust = customers.find(x => x._key === custKey);
    if (!cust) return alert('Select customer');
    
    let total = window.calcSaleTotal();
    let paid = Number(document.getElementById('salePaid').value || 0);

    if (editKey) {
      let old = sales.find(x => x._key === editKey);
      if (old) {
        for (let it of old.items) {
          let p = products.find(x => x._key === it.productKey);
          if (p) { p.stock = (Number(p.stock)||0) + Number(it.qty); await saveByKey(p._key, cleanForSave(p)); }
        }
        cust.balance = (Number(cust.balance)||0) - (Number(old.total) - Number(old.paid));
      }
    }
    
    let payload = {
      date: document.getElementById('saleDate').value,
      invoiceNo: document.getElementById('saleNo').value,
      customerId: cust._key, customerName: cust.name,
      items: saleItems.filter(i => i.productKey),
      discount: Number(document.getElementById('saleDiscount').value),
      discountType: document.getElementById('saleDiscountType').value,
      extra: Number(document.getElementById('saleExtra').value),
      vat: Number(document.getElementById('saleVat').value),
      vatType: document.getElementById('saleVatType').value,
      ait: Number(document.getElementById('saleAit').value),
      aitType: document.getElementById('saleAitType').value,
      total: total, paid: paid, method: document.getElementById('saleMethod').value,
      bankKey: document.getElementById('saleBank').value
    };

    let res = editKey ? await saveByKey(editKey, payload) : await saveItem('sale:', payload);
    if (res) {
      for (let it of payload.items) {
        let p = products.find(x => x._key === it.productKey);
        if (p) { p.stock = (Number(p.stock)||0) - Number(it.qty); await saveByKey(p._key, cleanForSave(p)); }
      }
      cust.balance = (Number(cust.balance)||0) + (total - paid);
      await saveByKey(cust._key, cleanForSave(cust));
      closeModal('saleModal'); 
      window.initSales(); 
    }
  };

  window.printSale = function() {
    let content = document.getElementById('printArea').innerHTML;
    let win = window.open('', '_blank');
    win.document.write('<html><head><title>Invoice</title><style>body{font-family:sans-serif;padding:30px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}.r{text-align:right}</style></head><body>'+content+'</body></html>');
    win.document.close();
    setTimeout(() => { win.print(); win.close(); }, 500);
  };

  window.initSales();
  </script>`;
}
// ============================================================
// ACCOUNTS & BANKING (PRO VERSION - FULLY FIXED)
// ============================================================
function paymentsPage() {
  return `
  <div class="page-header">
    <div>
      <div class="page-title">Accounts & Banking</div>
      <div class="page-sub">Manage Cash, Banks, Cheques, and Ledgers</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-outline" onclick="window.openBankModal()">🏦 Banks</button>
      <button class="btn btn-outline" onclick="window.openChequeBook()">📖 Cheque Books</button>
      <button class="btn btn-outline" onclick="window.openLedger()">📊 Ledger</button>
      <button class="btn btn-outline" onclick="window.openChequeRegister()">🧾 Cheque Reg.</button>
      <button class="btn btn-outline" onclick="window.openTransferModal()">🔄 Transfer</button>
      <button class="btn btn-primary" onclick="window.openPaymentModal()">➕ New Entry</button>
    </div>
  </div>

  <div class="tabs" style="margin-bottom:15px">
    <button class="tab active" onclick="window.switchPayTab('receipt', this)">📥 Receipts</button>
    <button class="tab" onclick="window.switchPayTab('payment', this)">📤 Payments</button>
    <button class="tab" onclick="window.switchPayTab('transfer', this)">🔄 Transfers</button>
  </div>

  <div class="card" style="padding:0; overflow:hidden">
    <table class="tbl">
      <thead>
        <tr>
          <th>Date</th>
          <th>Voucher #</th>
          <th>Party / Description</th>
          <th>Method</th>
          <th class="r">Amount</th>
          <th>Status</th>
          <th class="r">Actions</th>
        </tr>
      </thead>
      <tbody id="payBody"></tbody>
    </table>
  </div>

  <div class="modal-overlay" id="payModal">
    <div class="modal" style="max-width:500px">
      <h3 id="payTitle">New Transaction</h3>
      <input type="hidden" id="payEditKey">
      <div class="form-row">
        <div><label>Date</label><input type="date" id="payDate"></div>
        <div><label>Voucher No</label><input id="payNo" readonly></div>
      </div>
      <div class="form-group">
        <label>Party / Account</label>
        <select id="payParty"></select>
      </div>
      <div class="form-row">
        <div>
          <label>Method</label>
          <select id="payMethod" onchange="window.handleMethodChange(this.value)">
            <option value="cash">💵 Cash</option>
            <option value="bank">🏦 Bank</option>
          </select>
        </div>
        <div id="typeWrap" style="display:none">
          <label>Type</label>
          <select id="payTransferType" onchange="window.handleTypeChange(this.value)">
            <option value="Online">Online/App</option>
            <option value="Cheque">Cheque</option>
          </select>
        </div>
      </div>
      <div id="chequeFields" style="display:none; background:#f3f4f6; padding:10px; border-radius:8px; margin-bottom:10px">
        <div class="form-row">
           <div><label>Cheque No</label><input id="payChequeNo"></div>
           <div><label>Cheque Date</label><input type="date" id="payChequeDate"></div>
        </div>
      </div>
      <div class="form-group" id="bankSelectWrap" style="display:none">
        <label>Select Bank</label>
        <select id="payBank"></select>
      </div>
      <div class="form-group">
        <label>Amount</label>
        <input type="number" id="payAmount">
      </div>
      <div class="form-group">
        <label>Note</label>
        <input id="payNote">
      </div>
      <div style="display:flex; gap:8px; margin-top:15px">
        <button class="btn btn-outline" onclick="closeModal('payModal')">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="window.savePayment()">Save</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="bankModal">
    <div class="modal" style="max-width:500px">
      <h3>Bank Accounts</h3>
      <div class="form-row">
        <input id="bName" placeholder="Bank Name">
        <input type="number" id="bOpen" placeholder="Opening">
        <button class="btn btn-primary" onclick="window.addBank()">Add</button>
      </div>
      <hr>
      <div id="bankDispList"></div> <button class="btn btn-outline" style="width:100%; margin-top:10px" onclick="closeModal('bankModal')">Close</button>
    </div>
  </div>

  <div class="modal-overlay" id="chequeModal">
    <div class="modal" style="max-width:800px">
      <h3>Cheque Register (Pending)</h3>
      <table class="tbl">
        <thead>
          <tr><th>Date</th><th>Cheque No</th><th>Bank</th><th>Party</th><th class="r">Amount</th><th>Action</th></tr>
        </thead>
        <tbody id="chequeRegBody"></tbody> </table>
      <button class="btn btn-outline" style="margin-top:10px" onclick="closeModal('chequeModal')">Close</button>
    </div>
  </div>

  <div class="modal-overlay" id="chequeBookModal">
    <div class="modal" style="max-width:500px">
      <h3>New Cheque Book</h3>
      <select id="cbBank" class="form-group"></select>
      <input id="cbPrefix" placeholder="Prefix" class="form-group">
      <div class="form-row">
        <input type="number" id="cbFrom" placeholder="From">
        <input type="number" id="cbTo" placeholder="To">
      </div>
      <button class="btn btn-primary" style="width:100%; margin-top:10px" onclick="window.saveChequeBook()">Add Book</button>
      <div id="cbList" style="margin-top:10px; max-height:150px; overflow:auto"></div>
      <button class="btn btn-outline" style="width:100%; margin-top:10px" onclick="closeModal('chequeBookModal')">Close</button>
    </div>
  </div>

  <div class="modal-overlay" id="transferModal">
    <div class="modal" style="max-width:400px">
      <h3>Internal Transfer</h3>
      <select id="transType" class="form-group">
        <option value="C2B">Cash to Bank (Deposit)</option>
        <option value="B2C">Bank to Cash (Withdraw)</option>
      </select>
      <select id="transBank" class="form-group"></select>
      <input type="number" id="transAmount" class="form-group" placeholder="Amount">
      <button class="btn btn-primary" style="width:100%" onclick="window.saveTransfer()">Complete</button>
      <button class="btn btn-outline" style="width:100%; margin-top:8px" onclick="closeModal('transferModal')">Close</button>
    </div>
  </div>

  <div class="modal-overlay" id="ledgerModal">
    <div class="modal" style="max-width:850px">
      <h3>Bank Ledger</h3>
      <div class="form-row" style="align-items:end">
        <select id="lBank" style="width:200px"></select>
        <input type="date" id="lFrom">
        <input type="date" id="lTo">
        <button class="btn btn-primary" onclick="window.loadLedger()">Load</button>
      </div>
      <div style="max-height:400px; overflow-y:auto; margin-top:15px">
        <table class="tbl">
          <thead><tr><th>Date</th><th>Voucher</th><th>Party</th><th class="r">Dr</th><th class="r">Cr</th><th class="r">Balance</th></tr></thead>
          <tbody id="ledgerBody"></tbody>
        </table>
      </div>
      <button class="btn btn-outline" style="margin-top:10px" onclick="closeModal('ledgerModal')">Close</button>
    </div>
  </div>

  <script>
  var payments=[], banks=[], parties=[], chequeBooks=[], currentTab='receipt';

  window.initPayments = async function() {
    let d = await Promise.all([loadList('payment:'), loadList('bank:'), loadList('party:'), loadList('cb:')]);
    payments = d[0] || [];
    banks = d[1] || [];
    parties = d[2] || [];
    chequeBooks = d[3] || [];
    window.renderPayTable();
  };

  window.renderPayTable = function() {
    let filtered = payments.filter(p => p.type === currentTab);
    document.getElementById('payBody').innerHTML = filtered.map(p => \`
      <tr>
        <td>\${p.date || '-'}</td>
        <td><b>\${p.no || '-'}</b></td>
        <td>\${p.party || 'No Party'} <br><small style="color:#666">\${p.note || ''}</small></td>
        <td>\${(p.method || 'cash').toUpperCase()} \${p.chequeNo ? '<br><small>#'+p.chequeNo+'</small>' : ''}</td>
        <td class="r bold">\${fmt(p.amount || 0)}</td>
        <td><span class="badge \${p.status==='done'?'bg-success':'bg-warning'}">\${(p.status || 'pending').toUpperCase()}</span></td>
        <td class="r">
          <button class="btn btn-outline btn-sm" onclick="window.printVoucher('\${p._key}')">🖨</button>
          <button class="btn btn-outline btn-sm" onclick="window.editPayment('\${p._key}')">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="window.deletePayment('\${p._key}')">🗑</button>
        </td>
      </tr>\`).join('');
  };

  window.switchPayTab = function(t, el) {
    currentTab = t;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    window.renderPayTable();
  };

  window.openPaymentModal = function() {
    document.getElementById('payEditKey').value = '';
    document.getElementById('payDate').value = todayISO();
    document.getElementById('payNo').value = txnNo(currentTab === 'receipt' ? 'RCT' : 'PAY');
    document.getElementById('payParty').innerHTML = parties.map(p => '<option value="'+p.name+'">'+p.name+'</option>').join('');
    document.getElementById('payBank').innerHTML = banks.map(b => '<option value="'+b._key+'">'+b.name+'</option>').join('');
    window.handleMethodChange('cash');
    openModal('payModal');
  };

  window.handleMethodChange = function(v) {
    document.getElementById('typeWrap').style.display = v === 'bank' ? 'block' : 'none';
    document.getElementById('bankSelectWrap').style.display = v === 'bank' ? 'block' : 'none';
    if(v === 'cash') window.handleTypeChange('');
  };

  window.handleTypeChange = function(v) {
    document.getElementById('chequeFields').style.display = v === 'Cheque' ? 'block' : 'none';
  };

  // ✅ FIXED: Restored editPayment
  window.editPayment = function(key) {
    let p = payments.find(x => x._key === key);
    if(!p) return;
    document.getElementById('payEditKey').value = p._key;
    document.getElementById('payDate').value = p.date;
    document.getElementById('payNo').value = p.no;
    document.getElementById('payParty').value = p.party;
    document.getElementById('payMethod').value = p.method;
    window.handleMethodChange(p.method);
    document.getElementById('payTransferType').value = p.transferType || '';
    window.handleTypeChange(p.transferType);
    document.getElementById('payChequeNo').value = p.chequeNo || '';
    document.getElementById('payChequeDate').value = p.chequeDate || '';
    document.getElementById('payAmount').value = p.amount;
    document.getElementById('payNote').value = p.note || '';
    if(p.bankId) document.getElementById('payBank').value = p.bankId;
    openModal('payModal');
  };

  // ✅ FIXED: Restored deletePayment
  window.deletePayment = async function(key) {
    if(!confirm('Delete this transaction?')) return;
    let p = payments.find(x => x._key === key);
    if(p && p.status === 'done') await window.updateBalance(p, 'reverse');
    await deleteItem(key, true);
    window.initPayments();
  };

  window.savePayment = async function() {
    let editKey = document.getElementById('payEditKey').value;
    let amt = Number(document.getElementById('payAmount').value || 0);
    let method = document.getElementById('payMethod').value;
    let tType = document.getElementById('payTransferType').value;
    let status = (method === 'bank' && tType === 'Cheque') ? 'pending' : 'done';

    let data = {
      date: document.getElementById('payDate').value,
      no: document.getElementById('payNo').value,
      party: document.getElementById('payParty').value,
      type: currentTab,
      method: method,
      bankId: method === 'bank' ? document.getElementById('payBank').value : '',
      transferType: tType,
      chequeNo: document.getElementById('payChequeNo').value,
      chequeDate: document.getElementById('payChequeDate').value,
      amount: amt,
      note: document.getElementById('payNote').value,
      status: status
    };

    if(editKey) {
      let old = payments.find(x => x._key === editKey);
      if(old && old.status === 'done') await window.updateBalance(old, 'reverse');
    }

    let res = editKey ? await saveByKey(editKey, data) : await saveItem('payment:', data);
    if(res && status === 'done') await window.updateBalance(data, 'apply');

    closeModal('payModal');
    window.initPayments();
  };

  window.updateBalance = async function(p, mode) {
    if(p.method === 'bank' && p.bankId) {
      let b = banks.find(x => x._key === p.bankId);
      if(b) {
        let amt = (p.type === 'receipt' || p.note === 'Cash to Bank') ? p.amount : -p.amount;
        b.balance = (Number(b.balance)||0) + (mode === 'apply' ? amt : -amt);
        await saveByKey(b._key, cleanForSave(b));
      }
    }
  };

  // ✅ FIXED: Restored openChequeRegister
  window.openChequeRegister = function() {
    let pending = payments.filter(p => p.status === 'pending');
    let html = pending.map(p => {
      let b = banks.find(x => x._key === p.bankId);
      return \`<tr>
        <td>\${p.chequeDate}</td>
        <td>\${p.chequeNo}</td>
        <td>\${b ? b.name : '-'}</td>
        <td>\${p.party}</td>
        <td class="r">\${fmt(p.amount)}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="window.honorCheque('\${p._key}')">✔ Honor</button>
          <button class="btn btn-danger btn-sm" onclick="window.bounceCheque('\${p._key}')">✖</button>
        </td>
      </tr>\`;
    }).join('');
    document.getElementById('chequeRegBody').innerHTML = html || '<tr><td colspan="6" class="c">No pending cheques</td></tr>';
    openModal('chequeModal');
  };

  window.honorCheque = async function(key) {
    let p = payments.find(x => x._key === key);
    if(!p) return;
    p.status = 'done';
    await window.updateBalance(p, 'apply');
    await saveByKey(p._key, cleanForSave(p));
    closeModal('chequeModal');
    window.initPayments();
  };

  window.bounceCheque = async function(key) {
    let p = payments.find(x => x._key === key);
    if(!p) return;
    p.status = 'bounced';
    await saveByKey(p._key, cleanForSave(p));
    closeModal('chequeModal');
    window.initPayments();
  };

  // ✅ FIXED: Restored printVoucher
  window.printVoucher = function(key) {
    let p = payments.find(x => x._key === key);
    let win = window.open('', '_blank');
    win.document.write(\`<html><head><title>Voucher</title><style>
      body{font-family:sans-serif; padding:30px;}
      .box{border:2px solid #333; padding:20px;}
      .h{display:flex; justify-content:space-between; border-bottom:1px solid #333; padding-bottom:10px;}
      .m{margin:20px 0; line-height:2;}
    </style></head><body>
      <div class="box">
        <div class="h"><h2>\${p.type.toUpperCase()} VOUCHER</h2> <b>No: \${p.no}</b></div>
        <div class="m">
          <b>Date:</b> \${p.date}<br>
          <b>Party:</b> \${p.party}<br>
          <b>Method:</b> \${p.method.toUpperCase()} \${p.chequeNo ? '(Chq: '+p.chequeNo+')' : ''}<br>
          <b>Note:</b> \${p.note || 'N/A'}<br><br>
          <div style="font-size:24px; font-weight:bold">Amount: \${fmt(p.amount)}</div>
        </div>
        <div style="margin-top:50px; display:flex; justify-content:space-between">
          <span>________________<br>Receiver Signature</span>
          <span>________________<br>Authorized Signature</span>
        </div>
      </div>
    </body></html>\`);
    win.document.close();
    win.print();
  };

  // --- OTHERS (UNCHANGED) ---
  window.openBankModal = function() {
    document.getElementById('bankDispList').innerHTML = banks.map(b => \`
      <div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #eee">
        <span>\${b.name}</span><span class="bold">\${fmt(b.balance)}</span>
      </div>\`).join('');
    openModal('bankModal');
  };

  window.addBank = async function() {
    let name = document.getElementById('bName').value;
    let bal = Number(document.getElementById('bOpen').value || 0);
    await saveItem('bank:', {name, opening: bal, balance: bal});
    window.initPayments();
  };

  window.openChequeBook = function() {
    document.getElementById('cbBank').innerHTML = banks.map(b => '<option value="'+b._key+'">'+b.name+'</option>').join('');
    document.getElementById('cbList').innerHTML = chequeBooks.map(cb => {
      let b = banks.find(x => x._key === cb.bank);
      return '<div>'+(b?b.name:'-')+' : '+cb.prefix+' ('+cb.from+'-'+cb.to+')</div>';
    }).join('');
    openModal('chequeBookModal');
  };

  window.saveChequeBook = async function() {
    await saveItem('cb:', {
      bank: document.getElementById('cbBank').value,
      prefix: document.getElementById('cbPrefix').value,
      from: document.getElementById('cbFrom').value,
      to: document.getElementById('cbTo').value
    });
    window.initPayments();
    closeModal('chequeBookModal');
  };

  window.openLedger = function() {
    document.getElementById('lBank').innerHTML = banks.map(b => '<option value="'+b._key+'">'+b.name+'</option>').join('');
    openModal('ledgerModal');
  };

  window.loadLedger = function() {
    let bid = document.getElementById('lBank').value;
    let b = banks.find(x => x._key === bid);
    let from = document.getElementById('lFrom').value;
    let to = document.getElementById('lTo').value;
    let filtered = payments.filter(p => p.bankId === bid && p.status === 'done' && (!from || p.date >= from) && (!to || p.date <= to)).sort((a,b) => a.date.localeCompare(b.date));
    let balance = Number(b.opening || 0);
    document.getElementById('ledgerBody').innerHTML = filtered.map(p => {
      let dr = (p.type === 'receipt' || p.note === 'Cash to Bank') ? p.amount : 0;
      let cr = (p.type === 'payment' || p.note === 'Bank to Cash') ? p.amount : 0;
      balance += (dr - cr);
      return \`<tr><td>\${p.date}</td><td>\${p.no}</td><td>\${p.party}</td><td class="r">\${dr?fmt(dr):''}</td><td class="r">\${cr?fmt(cr):''}</td><td class="r bold">\${fmt(balance)}</td></tr>\`;
    }).join('');
  };

  window.openTransferModal = function() {
    document.getElementById('transBank').innerHTML = banks.map(b => '<option value="'+b._key+'">'+b.name+'</option>').join('');
    openModal('transferModal');
  };

  window.saveTransfer = async function() {
    let data = {
      date: todayISO(), no: txnNo('TRF'), party: 'Internal Transfer',
      type: 'transfer', method: 'bank', bankId: document.getElementById('transBank').value,
      amount: Number(document.getElementById('transAmount').value), status: 'done',
      note: document.getElementById('transType').value === 'C2B' ? 'Cash to Bank' : 'Bank to Cash'
    };
    await saveItem('payment:', data);
    await window.updateBalance(data, 'apply');
    closeModal('transferModal');
    window.initPayments();
  };

  window.initPayments();
  </script>
  `;
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
