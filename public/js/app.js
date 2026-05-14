// public/js/app.js — Main App Controller

const API = {
    async request(method, endpoint, body = null, isFormData = false) {
        const opts = {
            method,
            credentials: 'include',
            headers: isFormData ? {} : { 'Content-Type': 'application/json' }
        };
        if (body) opts.body = isFormData ? body : JSON.stringify(body);
        const res = await fetch(`/api${endpoint}`, opts);
        return res.json();
    },
    get: (ep) => API.request('GET', ep),
    post: (ep, b, fd) => API.request('POST', ep, b, fd),
    patch: (ep, b) => API.request('PATCH', ep, b),
    delete: (ep) => API.request('DELETE', ep),
};

// ─── STATE ───
let currentUser = null;
let currentPage = 'dashboard';

// ─── INIT ───
document.addEventListener('DOMContentLoaded', async () => {
    applyTheme(localStorage.getItem('theme') || 'light');
    await checkAuth();
});

async function checkAuth() {
    const data = await API.get('/auth/me');
    if (data.success) {
        currentUser = data.user;
        showApp();
    } else {
        showLogin();
    }
}

// ─── THEME ───
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ─── AUTH ───
function showLogin() {
    document.getElementById('login-page').classList.remove('hidden');
    document.getElementById('app-layout').classList.add('hidden');
}

function showApp() {
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('app-layout').classList.remove('hidden');
    renderUserInfo();
    setupNav();
    navigateTo('dashboard');
}

async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-error');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in...';
    err.classList.add('hidden');

    const data = await API.post('/auth/login', { username, password });
    if (data.success) {
        currentUser = data.user;
        showApp();
    } else {
        err.textContent = data.message;
        err.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Sign In';
    }
}

async function handleLogout() {
    await API.post('/auth/logout');
    currentUser = null;
    showLogin();
}

// ─── NAV ───
function setupNav() {
    const nav = document.getElementById('sidebar-nav');
    const items = [
        { id: 'dashboard', icon: '📊', label: 'Dashboard', always: true },
        { id: 'tickets', icon: '🎫', label: 'Tickets', always: true },
        { id: 'create-ticket', icon: '➕', label: 'New Ticket', always: true },
        { id: 'my-tickets', icon: '📋', label: 'My Tickets', always: true },
        { id: 'users', icon: '👥', label: 'Users', perm: 'can_manage_users' },
        { id: 'roles', icon: '🔐', label: 'Roles', perm: 'can_manage_roles' },
    ];

    nav.innerHTML = items
        .filter(i => i.always || currentUser[i.perm])
        .map(i => `
            <div class="nav-item" data-page="${i.id}" onclick="navigateTo('${i.id}')">
                <span class="nav-icon">${i.icon}</span>
                <span>${i.label}</span>
            </div>
        `).join('');
}

function renderUserInfo() {
    const initials = currentUser.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('user-name').textContent = currentUser.full_name;
    document.getElementById('user-role').textContent = currentUser.role_name;
}

function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });

    const pageEl = document.getElementById('page-content');
    pageEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading...</p></div>';

    const titles = {
        dashboard: 'Dashboard', tickets: 'All Tickets', 'create-ticket': 'Create Ticket',
        'my-tickets': 'My Tickets', users: 'User Management', roles: 'Role Management'
    };
    document.getElementById('page-title').textContent = titles[page] || page;

    const pages = { dashboard, tickets, 'create-ticket': createTicketPage, 'my-tickets': myTickets, users: usersPage, roles: rolesPage };
    if (pages[page]) pages[page]();
}

// ─── DASHBOARD ───
async function dashboard() {
    const [statsData, ticketsData] = await Promise.all([
        API.get('/tickets/stats'),
        API.get('/tickets?limit=10')
    ]);

    const s = statsData.stats || {};
    const tks = ticketsData.tickets || [];

    const html = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon">🎫</div>
                <div class="stat-label">Total Tickets</div>
                <div class="stat-value">${s.total || 0}</div>
            </div>
            <div class="stat-card accent">
                <div class="stat-icon">📂</div>
                <div class="stat-label">Open</div>
                <div class="stat-value">${s.open_count || 0}</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-icon">🔄</div>
                <div class="stat-label">In Progress</div>
                <div class="stat-value">${s.in_progress_count || 0}</div>
            </div>
            <div class="stat-card success">
                <div class="stat-icon">✅</div>
                <div class="stat-label">Resolved</div>
                <div class="stat-value">${s.resolved_count || 0}</div>
            </div>
            <div class="stat-card danger">
                <div class="stat-icon">🚨</div>
                <div class="stat-label">Urgent Open</div>
                <div class="stat-value">${s.urgent_open || 0}</div>
            </div>
            ${currentUser.can_assign_tickets ? `
            <div class="stat-card">
                <div class="stat-icon">⚠️</div>
                <div class="stat-label">Unassigned</div>
                <div class="stat-value">${s.unassigned_count || 0}</div>
            </div>` : ''}
        </div>

        ${currentUser.can_assign_tickets ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
            <div class="card" style="cursor:pointer;" onclick="tickets('assigned')">
                <div class="card-body" style="display:flex;align-items:center;gap:14px;padding:16px 20px;">
                    <div style="width:42px;height:42px;background:var(--accent-light);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;font-size:20px;">📌</div>
                    <div>
                        <div style="font-size:13px;color:var(--text-muted);font-weight:600;">Assigned Tickets</div>
                        <div style="font-size:22px;font-weight:800;color:var(--accent);">${(s.total || 0) - (s.unassigned_count || 0)}</div>
                    </div>
                </div>
            </div>
            <div class="card" style="cursor:pointer;" onclick="tickets('unassigned')">
                <div class="card-body" style="display:flex;align-items:center;gap:14px;padding:16px 20px;">
                    <div style="width:42px;height:42px;background:var(--warning-light);border-radius:var(--radius);display:flex;align-items:center;justify-content:circle;font-size:20px;align-items:center;justify-content:center;">📭</div>
                    <div>
                        <div style="font-size:13px;color:var(--text-muted);font-weight:600;">Unassigned</div>
                        <div style="font-size:22px;font-weight:800;color:var(--warning);">${s.unassigned_count || 0}</div>
                    </div>
                </div>
            </div>
        </div>` : ''}

        <div class="card">
            <div class="card-header">
                <span class="card-title">Recent Tickets</span>
                <button class="btn btn-secondary btn-sm" onclick="navigateTo('tickets')">View All</button>
            </div>
            <div class="table-wrapper">
                ${renderTicketTable(tks)}
            </div>
        </div>
    `;

    document.getElementById('page-content').innerHTML = html;
}

// ─── TICKETS LIST ───
async function tickets(assignedFilter = '') {
    if (assignedFilter) navigateTo('tickets');
    await renderTicketList({ assigned: assignedFilter });
}

async function renderTicketList(filters = {}) {
    const pageEl = document.getElementById('page-content');

    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.assigned) params.set('assigned', filters.assigned);
    if (filters.search) params.set('search', filters.search);
    if (filters.page) params.set('page', filters.page);

    const data = await API.get(`/tickets?${params}`);
    const tks = data.tickets || [];

    pageEl.innerHTML = `
        <div class="filters-bar">
            <div class="search-input-wrap">
                <span class="search-icon">🔍</span>
                <input type="text" placeholder="Search tickets..." id="search-input" value="${filters.search || ''}">
            </div>
            <select class="filter-select" id="filter-status" onchange="applyFilters()">
                <option value="">All Status</option>
                <option value="Open" ${filters.status === 'Open' ? 'selected' : ''}>Open</option>
                <option value="In Progress" ${filters.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
                <option value="Pending" ${filters.status === 'Pending' ? 'selected' : ''}>Pending</option>
                <option value="Resolved" ${filters.status === 'Resolved' ? 'selected' : ''}>Resolved</option>
                <option value="Closed" ${filters.status === 'Closed' ? 'selected' : ''}>Closed</option>
            </select>
            <select class="filter-select" id="filter-priority" onchange="applyFilters()">
                <option value="">All Priority</option>
                <option value="Urgent" ${filters.priority === 'Urgent' ? 'selected' : ''}>Urgent</option>
                <option value="High" ${filters.priority === 'High' ? 'selected' : ''}>High</option>
                <option value="Normal" ${filters.priority === 'Normal' ? 'selected' : ''}>Normal</option>
                <option value="Low" ${filters.priority === 'Low' ? 'selected' : ''}>Low</option>
            </select>
            ${currentUser.can_assign_tickets ? `
            <select class="filter-select" id="filter-assigned" onchange="applyFilters()">
                <option value="">All</option>
                <option value="assigned" ${filters.assigned === 'assigned' ? 'selected' : ''}>Assigned</option>
                <option value="unassigned" ${filters.assigned === 'unassigned' ? 'selected' : ''}>Unassigned</option>
            </select>` : ''}
            <button class="btn btn-primary btn-sm" onclick="navigateTo('create-ticket')">➕ New Ticket</button>
        </div>

        <div class="card">
            <div class="table-wrapper">
                ${tks.length ? renderTicketTable(tks) : '<div class="empty-state"><div class="empty-icon">🎫</div><h3>No tickets found</h3><p>Try adjusting your filters.</p></div>'}
            </div>
            ${data.total > 20 ? renderPagination(data.page, Math.ceil(data.total / data.limit), data.total) : ''}
        </div>
    `;

    // Search debounce
    let searchTimer;
    document.getElementById('search-input').addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyFilters(), 400);
    });
}

function applyFilters() {
    const search = document.getElementById('search-input')?.value;
    const status = document.getElementById('filter-status')?.value;
    const priority = document.getElementById('filter-priority')?.value;
    const assigned = document.getElementById('filter-assigned')?.value;
    renderTicketList({ search, status, priority, assigned });
}

function renderTicketTable(tickets) {
    if (!tickets.length) return '<div class="empty-state"><div class="empty-icon">🎫</div><h3>No tickets</h3></div>';
    return `
        <table>
            <thead>
                <tr>
                    <th>Ticket #</th>
                    <th>Title</th>
                    <th>Category</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Assigned To</th>
                    <th>Created</th>
                </tr>
            </thead>
            <tbody>
                ${tickets.map(t => `
                    <tr onclick="openTicket(${t.ticket_id})" style="cursor:pointer;">
                        <td><span class="ticket-number">${t.ticket_number}</span></td>
                        <td><span class="ticket-link">${escHtml(t.title)}</span>
                            ${t.attachment_count > 0 ? `<span style="color:var(--text-muted);font-size:11px;margin-left:6px;">📎${t.attachment_count}</span>` : ''}
                        </td>
                        <td>${t.category_name || '—'}</td>
                        <td>${priorityBadge(t.priority)}</td>
                        <td>${statusBadge(t.status)}</td>
                        <td>${t.assigned_to_name ? `<span style="font-size:13px;">${escHtml(t.assigned_to_name)}</span>` : '<span style="color:var(--text-muted);font-size:12px;">Unassigned</span>'}</td>
                        <td style="color:var(--text-muted);font-size:12px;">${formatDate(t.created_at)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function renderPagination(page, totalPages, total) {
    return `
        <div class="pagination">
            <span>${total} total tickets</span>
            <div class="pagination-pages">
                ${page > 1 ? `<button class="page-btn" onclick="renderTicketList({page:${page-1}})">‹</button>` : ''}
                ${Array.from({length: Math.min(totalPages, 7)}, (_, i) => i + 1).map(p =>
                    `<button class="page-btn ${p === page ? 'active' : ''}" onclick="renderTicketList({page:${p}})">${p}</button>`
                ).join('')}
                ${page < totalPages ? `<button class="page-btn" onclick="renderTicketList({page:${page+1}})">›</button>` : ''}
            </div>
        </div>
    `;
}

// ─── MY TICKETS ───
async function myTickets() {
    await renderTicketList({ created_by: currentUser.user_id });
}

// ─── TICKET DETAIL ───
async function openTicket(ticketId) {
    const data = await API.get(`/tickets/${ticketId}`);
    if (!data.success) return showToast(data.message, 'error');

    const { ticket: t, attachments, comments, history } = data;

    let staffOptions = '';
    if (currentUser.can_assign_tickets) {
        const staffData = await API.get('/users/staff');
        staffOptions = `<option value="">Unassigned</option>` +
            (staffData.staff || []).map(s => `<option value="${s.user_id}" ${t.assigned_to_id == s.user_id ? 'selected' : ''}>${escHtml(s.full_name)} (${escHtml(s.role_name)})</option>`).join('');
    }

    const modalHtml = `
        <div class="modal-overlay active" id="ticket-modal">
            <div class="modal modal-lg">
                <div class="modal-header">
                    <div>
                        <span class="ticket-number" style="font-size:12px;">${t.ticket_number}</span>
                        <div class="modal-title" style="margin-top:2px;">${escHtml(t.title)}</div>
                    </div>
                    <button class="modal-close" onclick="closeModal('ticket-modal')">✕</button>
                </div>
                <div class="modal-body">
                    <div class="ticket-detail-grid">
                        <!-- LEFT COLUMN -->
                        <div>
                            <div class="tabs">
                                <button class="tab-btn active" onclick="switchTab('detail','tab-detail')">📄 Details</button>
                                <button class="tab-btn" onclick="switchTab('detail','tab-comments')">💬 Comments (${comments.length})</button>
                                <button class="tab-btn" onclick="switchTab('detail','tab-history')">📜 History</button>
                            </div>

                            <!-- DETAILS TAB -->
                            <div id="tab-detail">
                                <p style="color:var(--text-secondary);font-size:13.5px;line-height:1.7;margin-bottom:20px;">${escHtml(t.description)}</p>

                                ${attachments.length ? `
                                <div style="margin-bottom:20px;">
                                    <div class="form-label">Attachments</div>
                                    <div class="file-list">
                                        ${attachments.map(a => `
                                            <div class="file-item">
                                                <span class="file-icon">${fileIcon(a.file_type)}</span>
                                                <span class="file-name">${escHtml(a.original_name)}</span>
                                                <span class="file-size">${formatFileSize(a.file_size)}</span>
                                                <a href="/api/tickets/attachment/${a.attachment_id}/download" class="btn btn-secondary btn-sm" style="text-decoration:none;">⬇ Download</a>
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>` : ''}

                                ${t.resolution_notes ? `
                                <div style="background:var(--success-light);border:1px solid var(--success);border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:16px;">
                                    <div style="font-size:11px;font-weight:700;color:var(--success);margin-bottom:4px;">RESOLUTION NOTES</div>
                                    <div style="font-size:13.5px;color:var(--text-primary);">${escHtml(t.resolution_notes)}</div>
                                </div>` : ''}

                                ${currentUser.can_assign_tickets && t.status !== 'Closed' ? `
                                <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-top:16px;">
                                    <div class="form-label">Update Status</div>
                                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
                                        ${['Open','In Progress','Pending','Resolved','Closed'].map(s =>
                                            `<button class="btn btn-secondary btn-sm ${t.status === s ? 'btn-primary' : ''}" onclick="updateTicketStatus(${t.ticket_id},'${s}')">${s}</button>`
                                        ).join('')}
                                    </div>
                                    ${t.status === 'Resolved' || t.status === 'Closed' ? `
                                    <div class="form-group">
                                        <label class="form-label">Resolution Notes</label>
                                        <textarea class="form-textarea" id="resolution-notes" rows="3" placeholder="Describe how this was resolved...">${t.resolution_notes || ''}</textarea>
                                    </div>
                                    <button class="btn btn-primary btn-sm" onclick="saveResolution(${t.ticket_id})">Save Notes</button>` : ''}
                                </div>` : ''}
                            </div>

                            <!-- COMMENTS TAB -->
                            <div id="tab-comments" class="hidden">
                                <div style="margin-bottom:20px;">
                                    ${comments.length ? comments.map(c => `
                                        <div class="comment-item ${c.is_internal ? 'comment-internal' : ''}">
                                            <div class="comment-avatar">${c.full_name[0].toUpperCase()}</div>
                                            <div class="comment-body">
                                                <div class="comment-header">
                                                    <span class="comment-author">${escHtml(c.full_name)}</span>
                                                    <span class="comment-time">${formatDate(c.created_at)}</span>
                                                    ${c.is_internal ? '<span class="badge badge-warning" style="font-size:10px;">Internal</span>' : ''}
                                                </div>
                                                <div class="comment-text">${escHtml(c.comment)}</div>
                                            </div>
                                        </div>
                                    `).join('') : '<div class="empty-state" style="padding:24px;"><p>No comments yet.</p></div>'}
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Add Comment</label>
                                    <textarea class="form-textarea" id="new-comment" rows="3" placeholder="Write a comment..."></textarea>
                                </div>
                                ${currentUser.can_assign_tickets ? `
                                <label class="toggle-wrap" style="margin-bottom:12px;">
                                    <div class="toggle" id="internal-toggle" onclick="this.classList.toggle('on')"></div>
                                    <span style="font-size:13px;color:var(--text-secondary);">Internal note (hidden from requester)</span>
                                </label>` : ''}
                                <button class="btn btn-primary btn-sm" onclick="submitComment(${t.ticket_id})">Post Comment</button>
                            </div>

                            <!-- HISTORY TAB -->
                            <div id="tab-history" class="hidden">
                                ${history.length ? `
                                <div style="display:flex;flex-direction:column;gap:8px;">
                                    ${history.map(h => `
                                        <div style="display:flex;gap:12px;align-items:flex-start;">
                                            <div style="width:6px;height:6px;background:var(--accent);border-radius:50%;margin-top:6px;flex-shrink:0;"></div>
                                            <div>
                                                <div style="font-size:13px;"><strong>${escHtml(h.full_name)}</strong> changed <strong>${h.field_changed}</strong>
                                                    ${h.old_value ? `from <em>${h.old_value}</em>` : ''} to <strong>${h.new_value}</strong>
                                                </div>
                                                <div style="font-size:11px;color:var(--text-muted);">${formatDate(h.changed_at)}</div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>` : '<div class="empty-state" style="padding:24px;"><p>No history yet.</p></div>'}
                            </div>
                        </div>

                        <!-- RIGHT COLUMN — Meta -->
                        <div>
                            <div class="card" style="padding:16px;">
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Status</span>
                                    <span class="ticket-meta-value">${statusBadge(t.status)}</span>
                                </div>
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Priority</span>
                                    <span class="ticket-meta-value">${priorityBadge(t.priority)}</span>
                                </div>
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Category</span>
                                    <span class="ticket-meta-value">${t.category_name || '—'}</span>
                                </div>
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Submitted By</span>
                                    <span class="ticket-meta-value">${escHtml(t.created_by_name)}</span>
                                </div>
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Department</span>
                                    <span class="ticket-meta-value">${t.department || '—'}</span>
                                </div>
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Created</span>
                                    <span class="ticket-meta-value">${formatDate(t.created_at)}</span>
                                </div>
                                ${t.due_date ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Due Date</span>
                                    <span class="ticket-meta-value" style="color:var(--warning);">${formatDate(t.due_date)}</span>
                                </div>` : ''}
                                ${t.resolved_at ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Resolved</span>
                                    <span class="ticket-meta-value" style="color:var(--success);">${formatDate(t.resolved_at)}</span>
                                </div>` : ''}
                                ${currentUser.can_assign_tickets ? `
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Assigned To</span>
                                    <select class="form-select" style="margin-top:4px;" onchange="assignTicket(${t.ticket_id}, this.value)">
                                        ${staffOptions}
                                    </select>
                                </div>` : `
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Assigned To</span>
                                    <span class="ticket-meta-value">${t.assigned_to_name || 'Unassigned'}</span>
                                </div>`}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

async function updateTicketStatus(id, status) {
    const data = await API.patch(`/tickets/${id}`, { status });
    if (data.success) {
        closeModal('ticket-modal');
        showToast('Status updated!', 'success');
        if (currentPage === 'dashboard') dashboard();
        else renderTicketList();
    } else showToast(data.message, 'error');
}

async function saveResolution(id) {
    const notes = document.getElementById('resolution-notes')?.value;
    const data = await API.patch(`/tickets/${id}`, { resolution_notes: notes });
    if (data.success) showToast('Saved!', 'success');
    else showToast(data.message, 'error');
}

async function assignTicket(id, userId) {
    const data = await API.patch(`/tickets/${id}`, { assigned_to: userId || null });
    if (data.success) showToast('Ticket assigned!', 'success');
    else showToast(data.message, 'error');
}

async function submitComment(ticketId) {
    const comment = document.getElementById('new-comment')?.value?.trim();
    if (!comment) return showToast('Please enter a comment.', 'error');
    const isInternal = document.getElementById('internal-toggle')?.classList.contains('on') ? 1 : 0;
    const data = await API.post(`/tickets/${ticketId}/comments`, { comment, is_internal: isInternal });
    if (data.success) {
        closeModal('ticket-modal');
        showToast('Comment added!', 'success');
        openTicket(ticketId);
    } else showToast(data.message, 'error');
}

function switchTab(group, activeId) {
    ['tab-detail','tab-comments','tab-history'].forEach(id => {
        document.getElementById(id)?.classList.add('hidden');
    });
    document.getElementById(activeId)?.classList.remove('hidden');
    document.querySelectorAll('.tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes(activeId));
    });
}

// ─── CREATE TICKET ───
async function createTicketPage() {
    const [catData, deptData] = await Promise.all([
        API.get('/users/categories'),
        API.get('/users/departments')
    ]);
    const cats = (catData.categories || []).filter(c => c.is_active);
    const depts = (deptData.departments || []).filter(d => d.is_active);

    // If admin/staff, fetch all users for "Request by" dropdown
    let usersForRequest = [];
    if (currentUser.can_assign_tickets) {
        const ud = await API.get('/users/all-users');
        usersForRequest = ud.users || [];
    }

    const requestByField = currentUser.can_assign_tickets
        ? `<div class="form-group">
                <label class="form-label">Request by <span class="required">*</span></label>
                <select class="form-select" id="ct-requestby">
                    <option value="">Select user...</option>
                    ${usersForRequest.map(u => `<option value="${u.user_id}" ${u.user_id === currentUser.user_id ? 'selected' : ''}>${escHtml(u.full_name)}${u.department ? ' — ' + escHtml(u.department) : ''}</option>`).join('')}
                </select>
           </div>`
        : `<div class="form-group">
                <label class="form-label">Request by</label>
                <input class="form-input" value="${escHtml(currentUser.full_name)}" disabled style="opacity:0.7;">
                <input type="hidden" id="ct-requestby" value="${currentUser.user_id}">
           </div>`;

    document.getElementById('page-content').innerHTML = `
        <div style="max-width:700px;">
            <div class="card">
                <div class="card-header"><span class="card-title">🎫 Submit a New Ticket</span></div>
                <div class="card-body">
                    <div id="create-alert"></div>
                    <form id="create-ticket-form">
                        ${requestByField}
                        <div class="form-group">
                            <label class="form-label">Title <span class="required">*</span></label>
                            <input class="form-input" id="ct-title" placeholder="Brief description of the issue..." required>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Category</label>
                                <select class="form-select" id="ct-category">
                                    <option value="">Select category...</option>
                                    ${cats.map(c => `<option value="${c.category_id}">${escHtml(c.category_name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Priority <span class="required">*</span></label>
                                <select class="form-select" id="ct-priority">
                                    <option value="Normal">🔵 Normal</option>
                                    <option value="Low">⚪ Low</option>
                                    <option value="High">🟠 High</option>
                                    <option value="Urgent">🔴 Urgent</option>
                                </select>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Department</label>
                                <select class="form-select" id="ct-department">
                                    <option value="">Select department...</option>
                                    ${depts.map(d => `<option value="${escHtml(d.department_name)}" ${d.department_name === currentUser.department ? 'selected' : ''}>${escHtml(d.department_name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Due Date</label>
                                <input type="date" class="form-input" id="ct-due">
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Description <span class="required">*</span></label>
                            <textarea class="form-textarea" id="ct-desc" rows="5" placeholder="Detailed description of the issue..." required></textarea>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Attachments</label>
                            <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()" ondragover="handleDragOver(event)" ondrop="handleDrop(event)">
                                <div class="upload-icon">📎</div>
                                <p>Click to upload or <strong>drag and drop</strong></p>
                                <p style="font-size:11px;color:var(--text-muted);margin-top:4px;">Max 10MB per file · JPG, PNG, PDF, DOC, XLS, ZIP</p>
                            </div>
                            <input type="file" id="file-input" multiple accept=".jpg,.jpeg,.png,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip" class="hidden" onchange="handleFileSelect(event)">
                            <div class="file-list" id="file-list"></div>
                        </div>
                        <div style="display:flex;gap:10px;">
                            <button type="submit" class="btn btn-primary" id="create-btn">🎫 Submit Ticket</button>
                            <button type="button" class="btn btn-secondary" onclick="navigateTo('tickets')">Cancel</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    `;

    document.getElementById('create-ticket-form').addEventListener('submit', submitCreateTicket);
}

let selectedFiles = [];

function handleFileSelect(e) {
    const newFiles = Array.from(e.target.files);
    selectedFiles = [...selectedFiles, ...newFiles].slice(0, 5);
    renderFileList();
}

function handleDragOver(e) {
    e.preventDefault();
    document.getElementById('upload-area').classList.add('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    document.getElementById('upload-area').classList.remove('drag-over');
    const newFiles = Array.from(e.dataTransfer.files);
    selectedFiles = [...selectedFiles, ...newFiles].slice(0, 5);
    renderFileList();
}

function removeFile(idx) {
    selectedFiles.splice(idx, 1);
    renderFileList();
}

function renderFileList() {
    const list = document.getElementById('file-list');
    if (!list) return;
    list.innerHTML = selectedFiles.map((f, i) => `
        <div class="file-item">
            <span class="file-icon">${fileIcon(f.type)}</span>
            <span class="file-name">${escHtml(f.name)}</span>
            <span class="file-size">${formatFileSize(f.size)}</span>
            <span class="file-remove" onclick="removeFile(${i})">✕</span>
        </div>
    `).join('');
}

async function submitCreateTicket(e) {
    e.preventDefault();
    const btn = document.getElementById('create-btn');
    const alertEl = document.getElementById('create-alert');

    const title = document.getElementById('ct-title').value.trim();
    const desc = document.getElementById('ct-desc').value.trim();
    if (!title || !desc) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting...';

    const fd = new FormData();
    fd.append('title', title);
    fd.append('description', desc);
    fd.append('category_id', document.getElementById('ct-category').value);
    fd.append('priority', document.getElementById('ct-priority').value);
    fd.append('department', document.getElementById('ct-department').value);
    fd.append('due_date', document.getElementById('ct-due').value);
    const requestBy = document.getElementById('ct-requestby')?.value;
    if (requestBy) fd.append('request_by', requestBy);
    selectedFiles.forEach(f => fd.append('attachments', f));

    const data = await API.post('/tickets', fd, true);
    if (data.success) {
        alertEl.innerHTML = `<div class="alert alert-success">✅ Ticket <strong>${data.ticket_number}</strong> created successfully!</div>`;
        selectedFiles = [];
        document.getElementById('create-ticket-form').reset();
        document.getElementById('file-list').innerHTML = '';
        setTimeout(() => navigateTo('my-tickets'), 1500);
    } else {
        alertEl.innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
    }
    btn.disabled = false;
    btn.textContent = '🎫 Submit Ticket';
}

// ─── USERS PAGE ───
async function usersPage() {
    const [usersData, rolesData, catsData, deptsData] = await Promise.all([
        API.get('/users'), API.get('/users/roles'),
        API.get('/users/categories'), API.get('/users/departments')
    ]);
    const users = usersData.users || [];
    const roles = rolesData.roles || [];
    const cats = catsData.categories || [];
    const depts = deptsData.departments || [];

    document.getElementById('page-content').innerHTML = `
        <div class="tabs" style="margin-bottom:16px;">
            <button class="tab-btn active" onclick="switchUsersTab('tab-users')">👥 Users</button>
            <button class="tab-btn" onclick="switchUsersTab('tab-categories')">🗂 Categories</button>
            <button class="tab-btn" onclick="switchUsersTab('tab-departments')">🏢 Departments</button>
        </div>

        <div id="tab-users">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">👥 Users</span>
                    <button class="btn btn-primary btn-sm" onclick="openAddUserModal(${JSON.stringify(roles).replace(/"/g,'&quot;')}, ${JSON.stringify(depts).replace(/"/g,'&quot;')})">➕ Add User</button>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr>
                            <th>Name</th><th>Username</th><th>Email</th><th>Role</th>
                            <th>Department</th><th>Position</th><th>Branch</th><th>Phone</th>
                            <th>Status</th><th>Last Login</th><th>Actions</th>
                        </tr></thead>
                        <tbody>
                            ${users.map(u => `
                                <tr>
                                    <td><strong>${escHtml(u.full_name)}</strong>${u.must_change_password ? ' <span style="font-size:10px;color:var(--warning);">⚠ Must change pw</span>' : ''}</td>
                                    <td><code style="font-size:12px;background:var(--bg-input);padding:2px 6px;border-radius:4px;">${escHtml(u.username)}</code></td>
                                    <td style="color:var(--text-muted);font-size:13px;">${escHtml(u.email)}</td>
                                    <td><span class="badge badge-normal">${escHtml(u.role_name)}</span></td>
                                    <td>${u.department || '—'}</td>
                                    <td>${u.position || '—'}</td>
                                    <td>${u.branch || '—'}</td>
                                    <td>${u.phone || '—'}</td>
                                    <td><span class="badge ${u.is_active ? 'badge-resolved' : 'badge-closed'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
                                    <td style="color:var(--text-muted);font-size:12px;">${u.last_login ? formatDate(u.last_login) : 'Never'}</td>
                                    <td>
                                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                                            <button class="btn btn-secondary btn-sm" onclick='openEditUserModal(${JSON.stringify(u).replace(/'/g,"&#39;")}, ${JSON.stringify(roles).replace(/'/g,"&#39;")}, ${JSON.stringify(depts).replace(/'/g,"&#39;")})'>Edit</button>
                                            <button class="btn btn-sm" style="background:var(--warning-light);color:var(--warning);" onclick="confirmResetPassword(${u.user_id}, '${escHtml(u.full_name)}')">Reset PW</button>
                                            ${u.user_id !== currentUser.user_id ? `
                                            <button class="btn btn-sm" style="background:var(--${u.is_active ? 'danger' : 'success'}-light);color:var(--${u.is_active ? 'danger' : 'success'});" onclick="toggleUserStatus(${u.user_id}, ${u.is_active})">${u.is_active ? 'Deactivate' : 'Activate'}</button>` : ''}
                                        </div>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div id="tab-categories" class="hidden">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">🗂 Categories</span>
                    <button class="btn btn-primary btn-sm" onclick="openCategoryModal()">➕ New Category</button>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${cats.map(c => `
                                <tr>
                                    <td><strong>${escHtml(c.category_name)}</strong></td>
                                    <td style="color:var(--text-muted);font-size:13px;">${c.description || '—'}</td>
                                    <td><span class="badge ${c.is_active ? 'badge-resolved' : 'badge-closed'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
                                    <td><button class="btn btn-secondary btn-sm" onclick='openCategoryModal(${JSON.stringify(c).replace(/'/g,"&#39;")})'>Edit</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div id="tab-departments" class="hidden">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">🏢 Departments</span>
                    <button class="btn btn-primary btn-sm" onclick="openDepartmentModal()">➕ New Department</button>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${depts.map(d => `
                                <tr>
                                    <td><strong>${escHtml(d.department_name)}</strong></td>
                                    <td style="color:var(--text-muted);font-size:13px;">${d.description || '—'}</td>
                                    <td><span class="badge ${d.is_active ? 'badge-resolved' : 'badge-closed'}">${d.is_active ? 'Active' : 'Inactive'}</span></td>
                                    <td><button class="btn btn-secondary btn-sm" onclick='openDepartmentModal(${JSON.stringify(d).replace(/'/g,"&#39;")})'>Edit</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

function switchUsersTab(activeId) {
    ['tab-users','tab-categories','tab-departments'].forEach(id => {
        document.getElementById(id)?.classList.toggle('hidden', id !== activeId);
    });
    document.querySelectorAll('#page-content .tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes(activeId));
    });
}

function confirmResetPassword(userId, name) {
    if (!confirm(`Reset password of "${name}" to "123"?\n\nThey will be prompted to change it on next login.`)) return;
    resetUserPassword(userId);
}

async function resetUserPassword(userId) {
    const data = await API.post(`/users/${userId}/reset-password`, {});
    if (data.success) showToast('Password reset to 123!', 'success');
    else showToast(data.message, 'error');
}

function openAddUserModal(roles, depts) {
    const deptOptions = (depts || []).filter(d => d.is_active).map(d => `<option value="${escHtml(d.department_name)}">${escHtml(d.department_name)}</option>`).join('');
    const html = `
        <div class="modal-overlay active" id="add-user-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">➕ Add User</span>
                    <button class="modal-close" onclick="closeModal('add-user-modal')">✕</button>
                </div>
                <div class="modal-body">
                    <div id="user-form-alert"></div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Full Name <span class="required">*</span></label>
                            <input class="form-input" id="au-name" placeholder="Juan dela Cruz">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Username <span class="required">*</span></label>
                            <input class="form-input" id="au-username" placeholder="juandelacruz">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Email <span class="required">*</span></label>
                            <input type="email" class="form-input" id="au-email" placeholder="juan@company.com">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Phone</label>
                            <input class="form-input" id="au-phone" placeholder="09XX-XXX-XXXX">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Password <span class="required">*</span></label>
                            <input type="password" class="form-input" id="au-password" placeholder="Min. 8 characters">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Role <span class="required">*</span></label>
                            <select class="form-select" id="au-role">
                                ${roles.filter(r => currentUser.can_manage_roles || !r.can_manage_roles).map(r => `<option value="${r.role_id}">${escHtml(r.role_name)}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Department</label>
                            <select class="form-select" id="au-dept">
                                <option value="">Select department...</option>
                                ${deptOptions}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Position</label>
                            <input class="form-input" id="au-position" placeholder="e.g. IT Officer">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Branch</label>
                        <input class="form-input" id="au-branch" placeholder="e.g. Main Office, Cebu Branch">
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('add-user-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitAddUser()">Create User</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

async function submitAddUser() {
    const alertEl = document.getElementById('user-form-alert');
    const body = {
        full_name: document.getElementById('au-name').value.trim(),
        username: document.getElementById('au-username').value.trim(),
        email: document.getElementById('au-email').value.trim(),
        password: document.getElementById('au-password').value,
        role_id: document.getElementById('au-role').value,
        department: document.getElementById('au-dept').value.trim(),
        phone: document.getElementById('au-phone').value.trim(),
        position: document.getElementById('au-position').value.trim(),
        branch: document.getElementById('au-branch').value.trim(),
    };
    const data = await API.post('/users', body);
    if (data.success) {
        closeModal('add-user-modal');
        showToast('User created!', 'success');
        usersPage();
    } else {
        alertEl.innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
    }
}

function openEditUserModal(user, roles, depts) {
    const deptOptions = (depts || []).filter(d => d.is_active).map(d => `<option value="${escHtml(d.department_name)}" ${d.department_name === user.department ? 'selected' : ''}>${escHtml(d.department_name)}</option>`).join('');
    const html = `
        <div class="modal-overlay active" id="edit-user-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">✏️ Edit User: ${escHtml(user.full_name)}</span>
                    <button class="modal-close" onclick="closeModal('edit-user-modal')">✕</button>
                </div>
                <div class="modal-body">
                    <div id="edit-form-alert"></div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Full Name</label>
                            <input class="form-input" id="eu-name" value="${escHtml(user.full_name)}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Email</label>
                            <input type="email" class="form-input" id="eu-email" value="${escHtml(user.email)}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Phone</label>
                            <input class="form-input" id="eu-phone" value="${escHtml(user.phone || '')}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Role</label>
                            <select class="form-select" id="eu-role">
                                ${roles.filter(r => currentUser.can_manage_roles || !r.can_manage_roles).map(r => `<option value="${r.role_id}" ${r.role_id === user.role_id ? 'selected' : ''}>${escHtml(r.role_name)}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Department</label>
                            <select class="form-select" id="eu-dept">
                                <option value="">Select department...</option>
                                ${deptOptions}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Position</label>
                            <input class="form-input" id="eu-position" value="${escHtml(user.position || '')}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Branch</label>
                        <input class="form-input" id="eu-branch" value="${escHtml(user.branch || '')}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">New Password <span class="form-hint">(Leave blank to keep current)</span></label>
                        <input type="password" class="form-input" id="eu-password" placeholder="Min. 8 characters">
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('edit-user-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitEditUser(${user.user_id})">Save Changes</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

async function submitEditUser(userId) {
    const body = {
        full_name: document.getElementById('eu-name').value.trim(),
        email: document.getElementById('eu-email').value.trim(),
        role_id: document.getElementById('eu-role').value,
        department: document.getElementById('eu-dept').value.trim(),
        phone: document.getElementById('eu-phone').value.trim(),
        position: document.getElementById('eu-position').value.trim(),
        branch: document.getElementById('eu-branch').value.trim(),
    };
    const pw = document.getElementById('eu-password').value;
    if (pw) body.password = pw;

    const data = await API.patch(`/users/${userId}`, body);
    if (data.success) {
        closeModal('edit-user-modal');
        showToast('User updated!', 'success');
        usersPage();
    } else {
        document.getElementById('edit-form-alert').innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
    }
}

async function toggleUserStatus(userId, isActive) {
    const data = isActive
        ? await API.delete(`/users/${userId}`)
        : await API.patch(`/users/${userId}`, { is_active: true });
    if (data.success) { showToast('User updated!', 'success'); usersPage(); }
    else showToast(data.message, 'error');
}

// ─── CATEGORY MODAL ───
function openCategoryModal(cat) {
    const isEdit = !!cat;
    const html = `
        <div class="modal-overlay active" id="category-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">${isEdit ? '✏️ Edit Category' : '➕ New Category'}</span>
                    <button class="modal-close" onclick="closeModal('category-modal')">✕</button>
                </div>
                <div class="modal-body">
                    <div id="cat-alert"></div>
                    <div class="form-group">
                        <label class="form-label">Category Name <span class="required">*</span></label>
                        <input class="form-input" id="cat-name" value="${escHtml(cat?.category_name || '')}" placeholder="e.g. Network Problems">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Description</label>
                        <textarea class="form-textarea" id="cat-desc" rows="2" placeholder="Brief description...">${escHtml(cat?.description || '')}</textarea>
                    </div>
                    <label class="toggle-wrap">
                        <div class="toggle ${cat?.is_active !== false ? 'on' : ''}" id="cat-active"></div>
                        <div><div style="font-size:13px;font-weight:600;">Active</div><div style="font-size:12px;color:var(--text-muted);">Visible when creating tickets</div></div>
                    </label>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('category-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitCategory(${cat?.category_id || 'null'})">${isEdit ? 'Save Changes' : 'Create Category'}</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));
}

async function submitCategory(catId) {
    const body = {
        category_name: document.getElementById('cat-name').value.trim(),
        description: document.getElementById('cat-desc').value.trim(),
        is_active: document.getElementById('cat-active').classList.contains('on'),
    };
    if (!body.category_name) { document.getElementById('cat-alert').innerHTML = `<div class="alert alert-error">❌ Category name required.</div>`; return; }
    const data = catId ? await API.patch(`/users/categories/${catId}`, body) : await API.post('/users/categories', body);
    if (data.success) { closeModal('category-modal'); showToast(catId ? 'Category updated!' : 'Category created!', 'success'); usersPage(); switchUsersTab('tab-categories'); }
    else document.getElementById('cat-alert').innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
}

// ─── DEPARTMENT MODAL ───
function openDepartmentModal(dept) {
    const isEdit = !!dept;
    const html = `
        <div class="modal-overlay active" id="dept-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">${isEdit ? '✏️ Edit Department' : '➕ New Department'}</span>
                    <button class="modal-close" onclick="closeModal('dept-modal')">✕</button>
                </div>
                <div class="modal-body">
                    <div id="dept-alert"></div>
                    <div class="form-group">
                        <label class="form-label">Department Name <span class="required">*</span></label>
                        <input class="form-input" id="dept-name" value="${escHtml(dept?.department_name || '')}" placeholder="e.g. Human Resources">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Description</label>
                        <textarea class="form-textarea" id="dept-desc" rows="2" placeholder="Brief description...">${escHtml(dept?.description || '')}</textarea>
                    </div>
                    <label class="toggle-wrap">
                        <div class="toggle ${dept?.is_active !== false ? 'on' : ''}" id="dept-active"></div>
                        <div><div style="font-size:13px;font-weight:600;">Active</div><div style="font-size:12px;color:var(--text-muted);">Visible when adding users</div></div>
                    </label>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('dept-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitDepartment(${dept?.department_id || 'null'})">${isEdit ? 'Save Changes' : 'Create Department'}</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));
}

async function submitDepartment(deptId) {
    const body = {
        department_name: document.getElementById('dept-name').value.trim(),
        description: document.getElementById('dept-desc').value.trim(),
        is_active: document.getElementById('dept-active').classList.contains('on'),
    };
    if (!body.department_name) { document.getElementById('dept-alert').innerHTML = `<div class="alert alert-error">❌ Department name required.</div>`; return; }
    const data = deptId ? await API.patch(`/users/departments/${deptId}`, body) : await API.post('/users/departments', body);
    if (data.success) { closeModal('dept-modal'); showToast(deptId ? 'Department updated!' : 'Department created!', 'success'); usersPage(); switchUsersTab('tab-departments'); }
    else document.getElementById('dept-alert').innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
}

// ─── ROLES PAGE ───
async function rolesPage() {
    const data = await API.get('/users/roles');
    const roles = data.roles || [];

    document.getElementById('page-content').innerHTML = `
        <div class="card" style="max-width:800px;">
            <div class="card-header">
                <span class="card-title">🔐 Role Management</span>
                <button class="btn btn-primary btn-sm" onclick="openAddRoleModal()">➕ Add Role</button>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Role Name</th>
                            <th>Description</th>
                            <th>Assign Tickets</th>
                            <th>Manage Users</th>
                            <th>View All Tickets</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${roles.map(r => `
                            <tr>
                                <td><strong>${escHtml(r.role_name)}</strong></td>
                                <td style="color:var(--text-muted);font-size:13px;">${r.description || '—'}</td>
                                <td>${r.can_assign_tickets ? '✅' : '—'}</td>
                                <td>${r.can_manage_users ? '✅' : '—'}</td>
                                <td>${r.can_view_all_tickets ? '✅' : '—'}</td>
                                <td>
                                    ${!r.can_manage_roles ? `<button class="btn btn-secondary btn-sm" onclick='openEditRoleModal(${JSON.stringify(r).replace(/'/g,"&#39;")})'>Edit</button>` : '<span style="color:var(--text-muted);font-size:12px;">System</span>'}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function roleFormFields(role = {}) {
    return `
        <div class="form-group">
            <label class="form-label">Role Name <span class="required">*</span></label>
            <input class="form-input" id="rf-name" value="${escHtml(role.role_name || '')}" placeholder="e.g., Support Agent">
        </div>
        <div class="form-group">
            <label class="form-label">Description</label>
            <input class="form-input" id="rf-desc" value="${escHtml(role.description || '')}" placeholder="What does this role do?">
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:8px;">
            <label class="toggle-wrap">
                <div class="toggle ${role.can_assign_tickets ? 'on' : ''}" id="rf-assign"></div>
                <div><div style="font-size:13px;font-weight:600;">Can Assign Tickets</div><div style="font-size:12px;color:var(--text-muted);">Can assign tickets to staff members</div></div>
            </label>
            <label class="toggle-wrap">
                <div class="toggle ${role.can_manage_users ? 'on' : ''}" id="rf-users"></div>
                <div><div style="font-size:13px;font-weight:600;">Can Manage Users</div><div style="font-size:12px;color:var(--text-muted);">Can create, edit, and deactivate users</div></div>
            </label>
            <label class="toggle-wrap">
                <div class="toggle ${role.can_view_all_tickets ? 'on' : ''}" id="rf-viewall"></div>
                <div><div style="font-size:13px;font-weight:600;">Can View All Tickets</div><div style="font-size:12px;color:var(--text-muted);">Can see all tickets, not just their own</div></div>
            </label>
        </div>
    `;
}

function openAddRoleModal() {
    const html = `
        <div class="modal-overlay active" id="add-role-modal">
            <div class="modal">
                <div class="modal-header"><span class="modal-title">➕ Add Role</span><button class="modal-close" onclick="closeModal('add-role-modal')">✕</button></div>
                <div class="modal-body"><div id="role-alert"></div>${roleFormFields()}</div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('add-role-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitAddRole()">Create Role</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));
}

async function submitAddRole() {
    const body = {
        role_name: document.getElementById('rf-name').value.trim(),
        description: document.getElementById('rf-desc').value.trim(),
        can_assign_tickets: document.getElementById('rf-assign').classList.contains('on'),
        can_manage_users: document.getElementById('rf-users').classList.contains('on'),
        can_view_all_tickets: document.getElementById('rf-viewall').classList.contains('on'),
    };
    const data = await API.post('/users/roles', body);
    if (data.success) { closeModal('add-role-modal'); showToast('Role created!', 'success'); rolesPage(); }
    else document.getElementById('role-alert').innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
}

function openEditRoleModal(role) {
    const html = `
        <div class="modal-overlay active" id="edit-role-modal">
            <div class="modal">
                <div class="modal-header"><span class="modal-title">✏️ Edit Role: ${escHtml(role.role_name)}</span><button class="modal-close" onclick="closeModal('edit-role-modal')">✕</button></div>
                <div class="modal-body"><div id="edit-role-alert"></div>${roleFormFields(role)}</div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('edit-role-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitEditRole(${role.role_id})">Save Changes</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));
}

async function submitEditRole(roleId) {
    const body = {
        role_name: document.getElementById('rf-name').value.trim(),
        description: document.getElementById('rf-desc').value.trim(),
        can_assign_tickets: document.getElementById('rf-assign').classList.contains('on'),
        can_manage_users: document.getElementById('rf-users').classList.contains('on'),
        can_view_all_tickets: document.getElementById('rf-viewall').classList.contains('on'),
    };
    const data = await API.patch(`/users/roles/${roleId}`, body);
    if (data.success) { closeModal('edit-role-modal'); showToast('Role updated!', 'success'); rolesPage(); }
    else document.getElementById('edit-role-alert').innerHTML = `<div class="alert alert-error">❌ ${data.message}</div>`;
}

// ─── HELPERS ───
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function fileIcon(mimeType) {
    if (!mimeType) return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType === 'application/pdf') return '📕';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '📊';
    if (mimeType.includes('zip') || mimeType.includes('rar')) return '🗜️';
    return '📄';
}

function priorityBadge(p) {
    const map = { Urgent: 'urgent', High: 'high', Normal: 'normal', Low: 'low' };
    const icon = { Urgent: '🔴', High: '🟠', Normal: '🔵', Low: '⚪' };
    return `<span class="badge badge-${map[p] || 'normal'}">${icon[p] || ''} ${p}</span>`;
}

function statusBadge(s) {
    const map = { 'Open': 'open', 'In Progress': 'in-progress', 'Pending': 'pending', 'Resolved': 'resolved', 'Closed': 'closed' };
    return `<span class="badge badge-${map[s] || 'open'}">${s}</span>`;
}

function showToast(message, type = 'success') {
    const id = 'toast-' + Date.now();
    const colors = { success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)' };
    const bg = { success: 'var(--success-light)', error: 'var(--danger-light)', warning: 'var(--warning-light)' };
    const icons = { success: '✅', error: '❌', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.id = id;
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;background:${bg[type]};color:${colors[type]};border:1px solid ${colors[type]};border-radius:10px;padding:12px 18px;font-size:13.5px;font-weight:600;box-shadow:var(--shadow-lg);display:flex;align-items:center;gap:8px;animation:slideIn 0.3s ease;max-width:320px;`;
    toast.innerHTML = `${icons[type]} ${escHtml(message)}`;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => m.remove());
    }
});

// CSS animation
const style = document.createElement('style');
style.textContent = `@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
document.head.appendChild(style);
