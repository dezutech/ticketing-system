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
let currentActivityLogFilters = {};
let currentTicketFilters = {};
let notificationPollTimer = null;
let lastUnreadNotificationCount = 0;
let lastSeenNotificationId = 0;
let lastNotificationSoundAt = 0;
let passwordResetLookupToken = null;
let passwordResetVerifiedToken = null;
const PROFILE_STATUSES = ['Active', 'Busy', 'On Break', 'Away', 'On Leave', 'Offline'];
const IDLE_AWAY_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_ACTIVITY_THROTTLE_MS = 5000;
let idleAwayTimer = null;
let idleTrackingBound = false;
let lastIdleActivityHandledAt = 0;
let autoAwayStatusSet = false;
let usersActionContext = { usersById: new Map(), roles: [], depts: [] };

// ─── INIT ───
document.addEventListener('DOMContentLoaded', async () => {
    applyUiTheme(localStorage.getItem('ui-theme') || 'modern');
    applyNightMode(localStorage.getItem('night-mode') === 'true');
    applySidebarState(localStorage.getItem('sidebar-state') || 'expanded');
    setupSidebarTooltips();
    if (window.location.pathname === '/self-service') {
        showSelfServicePortal(false);
        return;
    }
    await checkAuth();
});

async function checkAuth() {
    const data = await API.get('/auth/me');
    if (data.success) {
        currentUser = data.user;
        applyUiTheme(currentUser.theme_preference || localStorage.getItem('ui-theme') || 'modern');
        applyNightMode(!!currentUser.night_mode_enabled);
        showApp();
    } else {
        showLogin();
    }
}

// ─── THEME ───
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-night-mode') === 'true';
    applyNightMode(!current);
}

function normalizeUiTheme(theme) {
    return ['modern', 'classic', 'luna'].includes(theme) ? theme : 'modern';
}

function applyUiTheme(theme) {
    const normalized = normalizeUiTheme(theme);
    document.documentElement.setAttribute('data-ui-theme', normalized);
    localStorage.setItem('ui-theme', normalized);
}

function applyNightMode(enabled) {
    const isEnabled = !!enabled;
    document.documentElement.setAttribute('data-night-mode', isEnabled ? 'true' : 'false');
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('night-mode', String(isEnabled));
    const sidebarBtn = document.getElementById('theme-toggle-sidebar');
    if (sidebarBtn) sidebarBtn.textContent = isEnabled ? 'Light Mode' : 'Night Mode';
    const menuThemeBtn = document.getElementById('theme-toggle-sidebar-new');
    if (menuThemeBtn) menuThemeBtn.textContent = isEnabled ? 'Light Mode' : 'Night Mode';
    document.querySelectorAll('[data-night-mode-button]').forEach(btn => {
        btn.innerHTML = isEnabled ? '&#9728;' : '&#9790;';
        btn.setAttribute('aria-label', isEnabled ? 'Disable night mode' : 'Enable night mode');
        btn.dataset.tip = isEnabled ? 'Disable night mode' : 'Enable night mode';
    });
    const profileToggle = document.getElementById('night-mode-toggle');
    if (profileToggle) profileToggle.classList.toggle('on', isEnabled);
    const profileCheck = document.getElementById('night-mode-checkbox');
    if (profileCheck) profileCheck.checked = isEnabled;
}

function applySidebarState(state) {
    const minimized = state === 'minimized';
    const layout = document.getElementById('app-layout');
    const toggle = document.getElementById('sidebar-toggle');
    document.body.classList.toggle('sidebar-minimized', minimized);
    if (layout) layout.classList.toggle('sidebar-minimized', minimized);
    if (toggle) {
        toggle.innerHTML = '☰';
        toggle.setAttribute('aria-label', minimized ? 'Expand sidebar' : 'Minimize sidebar');
        toggle.dataset.tip = minimized ? 'Expand sidebar' : 'Minimize sidebar';
    }
    hideSidebarTooltip();
    localStorage.setItem('sidebar-state', minimized ? 'minimized' : 'expanded');
}

function toggleSidebar() {
    const minimized = document.body.classList.contains('sidebar-minimized');
    applySidebarState(minimized ? 'expanded' : 'minimized');
}

window.toggleSidebar = toggleSidebar;

function openMobileSidebar() {
    document.body.classList.add('mobile-sidebar-open');
    hideSidebarTooltip();
}

function closeMobileSidebar() {
    document.body.classList.remove('mobile-sidebar-open');
    document.getElementById('user-menu')?.classList.add('hidden');
    hideSidebarTooltip();
}

function toggleMobileSidebar() {
    document.body.classList.toggle('mobile-sidebar-open');
    hideSidebarTooltip();
}

window.openMobileSidebar = openMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;
window.toggleMobileSidebar = toggleMobileSidebar;

function isMobileSidebarViewport() {
    return window.matchMedia('(max-width: 767px)').matches;
}

function supportsDesktopHover() {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function handleSidebarControl() {
    if (isMobileSidebarViewport()) {
        toggleMobileSidebar();
        return;
    }
    toggleSidebar();
}

window.handleSidebarControl = handleSidebarControl;

function setupSidebarToggle() {
    const toggle = document.getElementById('sidebar-toggle');
    if (!toggle || toggle.dataset.bound === 'true') return;
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        handleSidebarControl();
    });
}

let sidebarTooltipEl = null;
let sidebarTooltipTarget = null;

function getSidebarTooltipTarget(target) {
    if (!supportsDesktopHover() || isMobileSidebarViewport()) return null;
    const sidebarControl = target.closest?.('.sidebar-control[data-tip]');
    if (sidebarControl) return sidebarControl;
    if (!document.body.classList.contains('sidebar-minimized')) return null;
    return target.closest?.('.sidebar .nav-item[data-tip], .sidebar .user-info[data-tip], .sidebar .sidebar-toggle[data-tip]') || null;
}

function ensureSidebarTooltip() {
    if (!sidebarTooltipEl) {
        sidebarTooltipEl = document.createElement('div');
        sidebarTooltipEl.className = 'sidebar-floating-tooltip';
        sidebarTooltipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(sidebarTooltipEl);
    }
    return sidebarTooltipEl;
}

function positionSidebarTooltip(target) {
    if (!sidebarTooltipEl || !target) return;
    const rect = target.getBoundingClientRect();
    const tooltipRect = sidebarTooltipEl.getBoundingClientRect();
    const gap = 12;
    const viewportPadding = 8;
    const left = Math.min(
        rect.right + gap,
        window.innerWidth - tooltipRect.width - viewportPadding
    );
    const top = Math.max(
        viewportPadding,
        Math.min(
            rect.top + (rect.height - tooltipRect.height) / 2,
            window.innerHeight - tooltipRect.height - viewportPadding
        )
    );

    sidebarTooltipEl.style.left = `${Math.max(viewportPadding, left)}px`;
    sidebarTooltipEl.style.top = `${top}px`;
}

function showSidebarTooltip(target) {
    const text = target?.dataset?.tip?.trim();
    if (!text) return;
    sidebarTooltipTarget = target;
    const tooltip = ensureSidebarTooltip();
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    positionSidebarTooltip(target);
}

function hideSidebarTooltip(target = null) {
    if (target && target !== sidebarTooltipTarget) return;
    sidebarTooltipTarget = null;
    if (sidebarTooltipEl) sidebarTooltipEl.classList.remove('visible');
}

function setupSidebarTooltips() {
    if (document.body.dataset.sidebarTooltipsBound === 'true') return;
    document.body.dataset.sidebarTooltipsBound = 'true';

    document.addEventListener('mouseover', event => {
        const target = getSidebarTooltipTarget(event.target);
        if (!target) return;
        showSidebarTooltip(target);
    });
    document.addEventListener('mouseout', event => {
        const target = getSidebarTooltipTarget(event.target);
        if (!target || target.contains(event.relatedTarget)) return;
        hideSidebarTooltip(target);
    });
    document.addEventListener('focusin', event => {
        const target = getSidebarTooltipTarget(event.target);
        if (target) showSidebarTooltip(target);
    });
    document.addEventListener('focusout', event => {
        const target = getSidebarTooltipTarget(event.target);
        if (target) hideSidebarTooltip(target);
    });
    document.addEventListener('touchstart', () => hideSidebarTooltip(), { passive: true });
    window.addEventListener('resize', () => {
        if (!supportsDesktopHover() || isMobileSidebarViewport()) {
            hideSidebarTooltip();
            return;
        }
        positionSidebarTooltip(sidebarTooltipTarget);
    });
    window.addEventListener('scroll', () => hideSidebarTooltip(), true);
}

// ─── AUTH ───
function showLogin() {
    stopIdleAwayDetection();
    document.getElementById('self-service-page')?.classList.add('hidden');
    document.getElementById('login-page').classList.remove('hidden');
    document.getElementById('app-layout').classList.add('hidden');
    resetLoginButton();
}

function showApp() {
    document.getElementById('self-service-page')?.classList.add('hidden');
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('app-layout').classList.remove('hidden');
    setupSidebarToggle();
    applySidebarState(localStorage.getItem('sidebar-state') || 'expanded');
    renderUserInfo();
    setupNav();
    startNotificationPolling();
    startIdleAwayDetection();
    navigateTo(getSavedPage());
}

function getSavedPage() {
    const page = localStorage.getItem('current-page') || 'dashboard';
    const allowedPages = new Set([
        'dashboard', 'tickets', 'create-ticket', 'my-tickets', 'users', 'roles',
        'reports', 'activity-logs', 'backups', 'assets', 'add-asset', 'edit-asset', 'asset-details'
    ]);
    return allowedPages.has(page) ? page : 'dashboard';
}

function showSelfServicePortal(updateUrl = true) {
    document.getElementById('login-page')?.classList.add('hidden');
    document.getElementById('app-layout')?.classList.add('hidden');
    document.getElementById('self-service-page')?.classList.remove('hidden');
    resetPasswordResetFlow();
    if (updateUrl && window.location.pathname !== '/self-service') {
        history.pushState({}, '', '/self-service');
    }
}

function openSelfServicePortal() {
    showSelfServicePortal();
}

function returnToLogin() {
    closeModal('password-reset-confirmation');
    resetPasswordResetFlow();
    history.pushState({}, '', '/');
    showLogin();
}

window.openSelfServicePortal = openSelfServicePortal;
window.returnToLogin = returnToLogin;

window.addEventListener('popstate', () => {
    if (window.location.pathname === '/self-service') {
        showSelfServicePortal(false);
    } else if (currentUser) {
        showApp();
    } else {
        showLogin();
    }
});

function resetLoginButton() {
    const btn = document.getElementById('login-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = 'Sign In';
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

    try {
        const data = await API.post('/auth/login', { username, password });
        if (data.success) {
            currentUser = data.user;
            applyUiTheme(currentUser.theme_preference || 'modern');
            applyNightMode(!!currentUser.night_mode_enabled);
            showApp();
        } else {
            err.textContent = data.message;
            err.classList.remove('hidden');
            resetLoginButton();
        }
    } catch (error) {
        err.textContent = 'Unable to sign in. Please try again.';
        err.classList.remove('hidden');
        resetLoginButton();
    }
}

function setPasswordResetStep(step) {
    document.getElementById('password-reset-find-form')?.classList.toggle('hidden', step !== 1);
    document.getElementById('password-reset-phone-form')?.classList.toggle('hidden', step !== 2);
    document.getElementById('password-reset-request-form')?.classList.toggle('hidden', step !== 3);
    [1, 2, 3].forEach(num => {
        document.getElementById(`pr-step-dot-${num}`)?.classList.toggle('active', num === step);
        document.getElementById(`pr-step-dot-${num}`)?.classList.toggle('complete', num < step);
    });
}

function resetPasswordResetFlow() {
    passwordResetLookupToken = null;
    passwordResetVerifiedToken = null;
    document.getElementById('self-service-alert').innerHTML = '';
    document.getElementById('password-reset-find-form')?.reset();
    document.getElementById('password-reset-phone-form')?.reset();
    document.getElementById('password-reset-request-form')?.reset();
    setPasswordResetStep(1);
}

async function submitPasswordResetFindAccount(e) {
    e.preventDefault();
    const btn = document.getElementById('password-reset-find-btn');
    const alertEl = document.getElementById('self-service-alert');
    const identifier = document.getElementById('pr-account-identifier').value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Searching...';
    alertEl.innerHTML = '';

    try {
        const data = await API.post('/tickets/password-reset/find-account', { identifier });
        if (data.success) {
            passwordResetLookupToken = data.lookup_token;
            document.getElementById('pr-found-name').textContent = data.display_name;
            document.getElementById('pr-masked-phone').textContent = data.masked_phone;
            setPasswordResetStep(2);
        } else {
            alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'No user or email found.')}</div>`;
        }
    } catch (error) {
        alertEl.innerHTML = '<div class="alert alert-error">Unable to search account. Please try again.</div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Search';
    }
}

async function submitPasswordResetVerifyPhone(e) {
    e.preventDefault();
    const btn = document.getElementById('password-reset-verify-btn');
    const alertEl = document.getElementById('self-service-alert');
    const phone = document.getElementById('pr-phone-verify').value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying...';
    alertEl.innerHTML = '';

    try {
        const data = await API.post('/tickets/password-reset/verify-phone', {
            lookup_token: passwordResetLookupToken,
            phone
        });
        if (data.success) {
            passwordResetVerifiedToken = data.verified_token;
            document.getElementById('pr-full-name').value = data.user.full_name || '';
            document.getElementById('pr-username-email').value = data.user.username_or_email || '';
            document.getElementById('pr-department').value = data.user.department || '';
            document.getElementById('pr-branch').value = data.user.branch || '';
            document.getElementById('pr-contact').value = data.user.contact_number || '';
            setPasswordResetStep(3);
        } else {
            alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Phone number does not match our records.')}</div>`;
        }
    } catch (error) {
        alertEl.innerHTML = '<div class="alert alert-error">Phone number does not match our records.</div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Continue';
    }
}

async function submitPasswordResetRequest(e) {
    e.preventDefault();
    const btn = document.getElementById('password-reset-submit-btn');
    const alertEl = document.getElementById('self-service-alert');
    const body = {
        verified_token: passwordResetVerifiedToken,
        account_system: document.getElementById('pr-system').value.trim(),
        reason: document.getElementById('pr-reason').value.trim(),
        additional_notes: document.getElementById('pr-notes').value.trim()
    };

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting...';
    alertEl.innerHTML = '';

    try {
        const data = await API.post('/tickets/password-reset-request', body);
        if (data.success) {
            resetPasswordResetFlow();
            showPasswordResetConfirmation(data.ticket_number);
        } else {
            alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to submit request.')}</div>`;
        }
    } catch (error) {
        alertEl.innerHTML = '<div class="alert alert-error">Unable to submit request. Please try again.</div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit Request';
    }
}

function showPasswordResetConfirmation(ticketNumber) {
    closeModal('password-reset-confirmation');
    const html = `
        <div class="modal-overlay active" id="password-reset-confirmation">
            <div class="modal" style="max-width:480px;">
                <div class="modal-header">
                    <span class="modal-title">Request Submitted</span>
                    <button class="modal-close" onclick="closeModal('password-reset-confirmation')">×</button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-success" style="margin-bottom:16px;">
                        Ticket <strong>${escHtml(ticketNumber)}</strong> has been created.
                    </div>
                    <p style="color:var(--text-secondary);font-size:13.5px;line-height:1.7;">
                        A support team member will verify your identity before any password reset is performed.
                    </p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="returnToLogin()">Back to Login</button>
                    <button class="btn btn-primary" onclick="closeModal('password-reset-confirmation')">Create Another Request</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

window.resetPasswordResetFlow = resetPasswordResetFlow;
window.submitPasswordResetFindAccount = submitPasswordResetFindAccount;
window.submitPasswordResetVerifyPhone = submitPasswordResetVerifyPhone;
window.submitPasswordResetRequest = submitPasswordResetRequest;

async function handleLogout() {
    await API.post('/auth/logout');
    setAutoAwayStoredFlag(false);
    stopIdleAwayDetection();
    currentUser = null;
    stopNotificationPolling();
    document.getElementById('notification-count')?.classList.add('hidden');
    document.getElementById('notification-panel')?.classList.add('hidden');
    showLogin();
}

async function loadNotifications() {
    if (!currentUser) return;
    const data = await API.get('/notifications?limit=20');
    if (!data.success) return;
    const notifications = data.notifications || [];
    const newestId = notifications[0]?.notification_id || 0;
    const unreadCount = data.unread_count || 0;
    if (lastSeenNotificationId && newestId > lastSeenNotificationId && unreadCount > lastUnreadNotificationCount) {
        ringNotificationBell();
        playNotificationSound();
        if (notifications.some(n => n.notification_id > lastSeenNotificationId && n.related_ticket_id)) {
            refreshActiveTicketList();
        }
    }
    lastSeenNotificationId = Math.max(lastSeenNotificationId, newestId);
    lastUnreadNotificationCount = unreadCount;
    renderNotificationCount(unreadCount);
    renderNotificationList(notifications);
}

function startNotificationPolling() {
    stopNotificationPolling();
    loadNotifications();
    notificationPollTimer = setInterval(loadNotifications, 20000);
}

function stopNotificationPolling() {
    if (notificationPollTimer) clearInterval(notificationPollTimer);
    notificationPollTimer = null;
    lastUnreadNotificationCount = 0;
    lastSeenNotificationId = 0;
}

function renderNotificationCount(count) {
    const badge = document.getElementById('notification-count');
    if (!badge) return;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count <= 0);
}

function renderNotificationList(notifications) {
    const list = document.getElementById('notification-list');
    if (!list) return;
    if (!notifications.length) {
        list.innerHTML = '<div class="empty-state" style="padding:20px;"><p>No notifications</p></div>';
        return;
    }
    list.innerHTML = notifications.map(n => `
        <div class="notification-item ${n.is_read ? '' : 'unread'}" onclick="openNotification(${n.notification_id}, '${escHtml(n.link_target || '')}')">
            <div class="notification-row">
                <span class="notification-dot"></span>
                <div>
                    <div class="notification-title">${escHtml(n.title || n.message)}</div>
                    <div class="notification-message">${escHtml(n.message)}</div>
                    <div class="notification-meta">${n.related_ticket_id ? `Ticket #${escHtml(n.related_ticket_id)}` : escHtml(n.module)} | ${formatDate(n.created_at)}</div>
                </div>
            </div>
        </div>
    `).join('');
    return;
    list.innerHTML = notifications.map(n => `
        <div class="notification-item ${n.is_read ? '' : 'unread'}" onclick="openNotification(${n.notification_id}, '${escHtml(n.link_target || '')}')">
            <div class="notification-message">${escHtml(n.message)}</div>
            <div class="notification-meta">${escHtml(n.module)} • ${formatDate(n.created_at)}</div>
        </div>
    `).join('');
}

async function toggleNotifications() {
    const panel = document.getElementById('notification-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) await loadNotifications();
}

async function openNotification(id, target) {
    await API.patch(`/notifications/${id}/read`, {});
    await loadNotifications();
    document.getElementById('notification-panel')?.classList.add('hidden');
    if (target.startsWith('ticket:')) openTicket(Number(target.split(':')[1]));
    if (target.startsWith('asset:')) openAssetDetails(Number(target.split(':')[1]));
}

async function markAllNotificationsRead() {
    await API.patch('/notifications/read-all', {});
    await loadNotifications();
}

function ringNotificationBell() {
    const bell = document.getElementById('notification-toggle-float');
    if (!bell) return;
    bell.classList.remove('ringing');
    void bell.offsetWidth;
    bell.classList.add('ringing');
}

function playNotificationSound() {
    const now = Date.now();
    if (now - lastNotificationSoundAt < 5000) return;
    lastNotificationSoundAt = now;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, ctx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.16);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.24);
    } catch (err) {}
}

document.addEventListener('click', (event) => {
    const wrap = document.getElementById('floating-notification');
    const panel = document.getElementById('notification-panel');
    if (!wrap || !panel || panel.classList.contains('hidden')) return;
    if (!wrap.contains(event.target)) panel.classList.add('hidden');
});

// ─── NAV ───
function setupNav() {
    const nav = document.getElementById('sidebar-nav');
    const items = [
        { id: 'dashboard', icon: '📊', label: 'Dashboard', always: true },
        { id: 'tickets', icon: '🎫', label: 'Tickets', anyPerm: ['can_assign_tickets', 'can_view_all_tickets'] },
        { id: 'create-ticket', icon: '➕', label: 'New Ticket', always: true },
        { id: 'my-tickets', icon: '📋', label: 'My Tickets', always: true },
        { id: 'users', icon: '👥', label: 'Users', perm: 'can_manage_users' },
        { id: 'roles', icon: '🔐', label: 'Roles', perm: 'can_manage_roles' },
        { id: 'reports', icon: 'R', label: 'Reports', anyRole: ['Super Admin', 'Admin'] },
        { id: 'activity-logs', icon: 'L', label: 'Activity Logs', anyRole: ['Super Admin', 'Admin'] },
        { id: 'backups', icon: 'B', label: 'Backup & Restore', anyRole: ['Super Admin'] },
    ];

    nav.innerHTML = items
        .filter(i => i.always || currentUser[i.perm] || i.anyPerm?.some(perm => currentUser[perm]) || i.anyRole?.includes(currentUser.role_name))
        .map(i => `
            <div class="nav-item" data-page="${i.id}" onclick="navigateTo('${i.id}')">
                <span class="nav-icon">${i.icon}</span>
                <span class="nav-text">${i.label}</span>
            </div>
        `).join('');
    updateSidebarTooltips();
}

function renderUserInfo() {
    const initials = currentUser.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('topbar-user-avatar').textContent = initials;
    document.getElementById('menu-user-avatar').textContent = initials;
    document.getElementById('user-name').textContent = currentUser.full_name;
    document.getElementById('user-role').textContent = currentUser.role_name;
    const status = normalizeProfileStatus(currentUser.profile_status);
    const sidebarStatus = document.getElementById('user-profile-status');
    if (sidebarStatus) sidebarStatus.textContent = status;
    document.getElementById('menu-user-name').textContent = currentUser.full_name;
    document.getElementById('menu-user-status').textContent = `${currentUser.role_name} – ${status}`;
    ['user-presence-dot', 'topbar-presence-dot', 'menu-presence-dot'].forEach(id => {
        setPresenceDot(document.getElementById(id), status);
    });
    renderStatusMenuOptions();
    document.querySelector('.user-info')?.setAttribute('data-tip', `${currentUser.full_name} - ${currentUser.role_name} - ${normalizeProfileStatus(currentUser.profile_status)}`);
}

function normalizeProfileStatus(status) {
    return PROFILE_STATUSES.includes(status) ? status : 'Active';
}

function profileStatusTone(status) {
    const map = {
        Active: 'active',
        Busy: 'busy',
        Away: 'away',
        'On Break': 'break',
        'On Leave': 'leave',
        Offline: 'offline'
    };
    return map[normalizeProfileStatus(status)] || 'active';
}

function setPresenceDot(dot, status) {
    if (!dot) return;
    dot.className = `presence-dot presence-${profileStatusTone(status)}`;
    dot.title = normalizeProfileStatus(status);
    dot.setAttribute('aria-label', normalizeProfileStatus(status));
}

function profileStatusBadge(status, compact = false) {
    const normalized = normalizeProfileStatus(status);
    return `<span class="presence-label ${compact ? 'compact' : ''}"><span class="presence-dot presence-${profileStatusTone(normalized)}"></span><span>${escHtml(normalized)}</span></span>`;
}

function profileStatusOptions(selected) {
    const normalized = normalizeProfileStatus(selected);
    return PROFILE_STATUSES.map(status => `<option value="${status}" ${status === normalized ? 'selected' : ''}>${status}</option>`).join('');
}

function renderStatusMenuOptions() {
    const menu = document.getElementById('status-menu-options');
    if (!menu || !currentUser) return;
    const currentStatus = normalizeProfileStatus(currentUser.profile_status);
    menu.innerHTML = PROFILE_STATUSES.map(status => `
        <button class="status-menu-option ${status === currentStatus ? 'active' : ''}" onclick="updateProfileStatus('${status}')">
            <span class="presence-dot presence-${profileStatusTone(status)}"></span>
            <span>${escHtml(status)}</span>
        </button>
    `).join('');
}

function setStatusMenuExpanded(expanded) {
    const menu = document.getElementById('status-menu-options');
    const toggle = document.getElementById('status-menu-toggle');
    if (!menu || !toggle) return;
    menu.classList.toggle('hidden', !expanded);
    toggle.classList.toggle('expanded', expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function toggleStatusMenu(event) {
    event?.preventDefault();
    event?.stopPropagation();
    const menu = document.getElementById('status-menu-options');
    if (!menu) return;
    setStatusMenuExpanded(menu.classList.contains('hidden'));
}

window.toggleStatusMenu = toggleStatusMenu;

async function updateProfileStatus(status, options = {}) {
    const normalized = normalizeProfileStatus(status);
    const data = await API.patch('/auth/status', { profile_status: normalized });
    if (data.success) {
        currentUser.profile_status = data.profile_status;
        if (options.automaticAway) {
            autoAwayStatusSet = normalized === 'Away';
            setAutoAwayStoredFlag(autoAwayStatusSet);
        } else if (options.restoreAutomaticAway) {
            autoAwayStatusSet = false;
            setAutoAwayStoredFlag(false);
        } else {
            autoAwayStatusSet = false;
            setAutoAwayStoredFlag(false);
            resetIdleAwayTimer();
        }
        renderUserInfo();
        if (!options.silent) {
            document.getElementById('user-menu')?.classList.add('hidden');
            showToast('Profile status updated.', 'success');
        }
    } else {
        renderUserInfo();
        if (!options.silent) showToast(data.message || 'Unable to update profile status.', 'error');
    }
    return data;
}

function autoAwayStorageKey() {
    return currentUser?.user_id ? `profile-auto-away-${currentUser.user_id}` : null;
}

function setAutoAwayStoredFlag(value) {
    const key = autoAwayStorageKey();
    if (!key) return;
    if (value) localStorage.setItem(key, 'true');
    else localStorage.removeItem(key);
}

function getAutoAwayStoredFlag() {
    const key = autoAwayStorageKey();
    return key ? localStorage.getItem(key) === 'true' : false;
}

function canSetAutomaticAway() {
    return !!currentUser && normalizeProfileStatus(currentUser.profile_status) === 'Active';
}

function resetIdleAwayTimer() {
    if (idleAwayTimer) clearTimeout(idleAwayTimer);
    idleAwayTimer = null;
    if (!currentUser || !canSetAutomaticAway()) return;
    idleAwayTimer = setTimeout(setAutomaticAwayStatus, IDLE_AWAY_TIMEOUT_MS);
}

async function setAutomaticAwayStatus() {
    idleAwayTimer = null;
    if (!canSetAutomaticAway()) return;
    await updateProfileStatus('Away', { silent: true, automaticAway: true });
}

async function restoreAutomaticAwayStatus() {
    if (!currentUser || !autoAwayStatusSet || normalizeProfileStatus(currentUser.profile_status) !== 'Away') return;
    const data = await updateProfileStatus('Active', { silent: true, restoreAutomaticAway: true });
    if (data.success) resetIdleAwayTimer();
}

function handleIdleActivity(force = false) {
    if (!currentUser) return;
    const now = Date.now();
    if (!force && now - lastIdleActivityHandledAt < IDLE_ACTIVITY_THROTTLE_MS) return;
    lastIdleActivityHandledAt = now;

    if (autoAwayStatusSet) {
        restoreAutomaticAwayStatus();
        return;
    }

    resetIdleAwayTimer();
}

function handleVisibilityForIdle() {
    if (!currentUser) return;
    if (document.visibilityState === 'visible') {
        handleIdleActivity(true);
    } else {
        resetIdleAwayTimer();
    }
}

function bindIdleAwayDetection() {
    if (idleTrackingBound) return;
    idleTrackingBound = true;
    ['mousemove', 'keydown', 'click', 'touchstart', 'touchmove'].forEach(eventName => {
        document.addEventListener(eventName, () => handleIdleActivity(false), { passive: true });
    });
    document.addEventListener('visibilitychange', handleVisibilityForIdle);
}

function startIdleAwayDetection() {
    bindIdleAwayDetection();
    autoAwayStatusSet = normalizeProfileStatus(currentUser?.profile_status) === 'Away' && getAutoAwayStoredFlag();
    lastIdleActivityHandledAt = Date.now();
    resetIdleAwayTimer();
}

function stopIdleAwayDetection() {
    if (idleAwayTimer) clearTimeout(idleAwayTimer);
    idleAwayTimer = null;
    autoAwayStatusSet = false;
    lastIdleActivityHandledAt = 0;
}

function updateSidebarTooltips() {
    document.querySelectorAll('#sidebar-nav .nav-item').forEach(item => {
        const label = item.querySelector('.nav-text')?.textContent?.trim();
        if (label) item.dataset.tip = label;
    });
}

function openViewProfile() {
    document.getElementById('user-menu')?.classList.add('hidden');
    const status = normalizeProfileStatus(currentUser?.profile_status);
    const html = `
        <div class="modal-overlay active" id="view-profile-modal">
            <div class="modal" style="max-width:440px;">
                <div class="modal-header">
                    <span class="modal-title">Profile</span>
                    <button class="modal-close" onclick="closeModal('view-profile-modal')">x</button>
                </div>
                <div class="modal-body">
                    <div class="profile-summary">
                        <div class="user-avatar-wrap">
                            <div class="user-avatar profile-summary-avatar">${escHtml((currentUser.full_name || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase())}</div>
                            <span class="presence-dot presence-${profileStatusTone(status)}"></span>
                        </div>
                        <div>
                            <h3>${escHtml(currentUser.full_name)}</h3>
                            <p>${escHtml(currentUser.role_name || '')}${currentUser.department ? ' - ' + escHtml(currentUser.department) : ''}</p>
                            ${profileStatusBadge(status)}
                        </div>
                    </div>
                    <div class="profile-detail-list">
                        <div><span>Email</span><strong>${escHtml(currentUser.email || '-')}</strong></div>
                        <div><span>Username</span><strong>${escHtml(currentUser.username || '-')}</strong></div>
                        <div><span>Department</span><strong>${escHtml(currentUser.department || '-')}</strong></div>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

function openProfileSettings() {
    document.getElementById('user-menu')?.classList.add('hidden');
    const selectedTheme = normalizeUiTheme(currentUser?.theme_preference || localStorage.getItem('ui-theme') || 'modern');
    const nightModeEnabled = currentUser?.night_mode_enabled ?? (localStorage.getItem('night-mode') === 'true');
    const html = `
        <div class="modal-overlay active" id="profile-settings-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">Profile Settings</span>
                    <button class="modal-close" onclick="closeModal('profile-settings-modal')">×</button>
                </div>
                <div class="modal-body">
                    <div id="profile-settings-alert"></div>
                    <div class="settings-block">
                        <div>
                            <div class="settings-title">Interface Theme</div>
                            <div class="settings-help">Choose how the whole ticketing system should look after login.</div>
                        </div>
                        <select class="form-select" id="ui-theme-select">
                            <option value="modern" ${selectedTheme === 'modern' ? 'selected' : ''}>Modern</option>
                            <option value="classic" ${selectedTheme === 'classic' ? 'selected' : ''}>Classic</option>
                            <option value="luna" ${selectedTheme === 'luna' ? 'selected' : ''}>Windows XP Luna</option>
                        </select>
                    </div>
                    <label class="settings-block settings-toggle-block" for="night-mode-checkbox">
                        <div>
                            <div class="settings-title">Night Mode</div>
                            <div class="settings-help">Use a darker global palette while keeping the selected theme.</div>
                        </div>
                        <span class="toggle-wrap">
                            <input class="sr-only" type="checkbox" id="night-mode-checkbox" ${nightModeEnabled ? 'checked' : ''}>
                            <span class="toggle ${nightModeEnabled ? 'on' : ''}" id="night-mode-toggle" aria-hidden="true"></span>
                        </span>
                    </label>
                    <div class="settings-block">
                        <div>
                            <div class="settings-title">Profile Status</div>
                            <div class="settings-help">Shown beside your name for staff and users. Ticket logic is unchanged.</div>
                        </div>
                        <select class="form-select" id="profile-status-settings-select">
                            ${profileStatusOptions(currentUser?.profile_status)}
                        </select>
                    </div>
                    <div class="theme-preview ${selectedTheme === 'classic' ? 'classic-preview' : ''} ${selectedTheme === 'luna' ? 'luna-preview' : ''} ${nightModeEnabled ? 'night-preview' : ''}" id="theme-preview">
                        <div class="theme-preview-title">Preview</div>
                        <div class="theme-preview-body">
                            <button class="btn btn-secondary btn-sm" type="button">Button</button>
                            <input class="form-input" value="${selectedTheme === 'classic' ? 'Classic panel' : selectedTheme === 'luna' ? 'Luna dialog panel' : 'Modern panel'}" readonly>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('profile-settings-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="saveProfileSettings()">Save Settings</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const updatePreview = () => {
        const preview = document.getElementById('theme-preview');
        const selected = document.getElementById('ui-theme-select')?.value;
        const nightMode = document.getElementById('night-mode-checkbox')?.checked;
        preview?.classList.toggle('classic-preview', selected === 'classic');
        preview?.classList.toggle('luna-preview', selected === 'luna');
        preview?.classList.toggle('night-preview', !!nightMode);
        document.getElementById('night-mode-toggle')?.classList.toggle('on', !!nightMode);
    };
    document.getElementById('ui-theme-select')?.addEventListener('change', updatePreview);
    document.getElementById('night-mode-checkbox')?.addEventListener('change', updatePreview);
}

async function saveProfileSettings() {
    const alertEl = document.getElementById('profile-settings-alert');
    const theme = normalizeUiTheme(document.getElementById('ui-theme-select')?.value);
    const nightModeEnabled = !!document.getElementById('night-mode-checkbox')?.checked;
    const profileStatus = normalizeProfileStatus(document.getElementById('profile-status-settings-select')?.value);
    const data = await API.patch('/auth/theme', { theme_preference: theme, night_mode_enabled: nightModeEnabled });

    if (data.success) {
        const statusChanged = profileStatus !== normalizeProfileStatus(currentUser.profile_status);
        if (statusChanged) {
            const statusData = await updateProfileStatus(profileStatus, { silent: true });
            if (!statusData.success) {
                alertEl.innerHTML = `<div class="alert alert-error">${escHtml(statusData.message || 'Unable to save profile status.')}</div>`;
                return;
            }
        }
        currentUser.theme_preference = data.theme_preference;
        currentUser.night_mode_enabled = !!data.night_mode_enabled;
        applyUiTheme(data.theme_preference);
        applyNightMode(data.night_mode_enabled);
        renderUserInfo();
        alertEl.innerHTML = '<div class="alert alert-success">Profile settings saved.</div>';
        setTimeout(() => closeModal('profile-settings-modal'), 700);
    } else {
        alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to save theme.')}</div>`;
    }
}

function navigateTo(page) {
    closeMobileSidebar();
    localStorage.setItem('current-page', page);
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });

    const pageEl = document.getElementById('page-content');
    pageEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading...</p></div>';

    const titles = {
        dashboard: 'Dashboard', tickets: 'All Tickets', 'create-ticket': 'Create Ticket',
        'my-tickets': 'My Tickets', users: 'User Management', roles: 'Role Management',
        reports: 'Reports Export',
        'activity-logs': 'Activity Logs',
        backups: 'Backup & Restore'
    };
    document.getElementById('page-title').textContent = titles[page] || page;

    const pages = { dashboard, tickets, 'create-ticket': createTicketPage, 'my-tickets': myTickets, users: usersPage, roles: rolesPage, reports: reportsPage, 'activity-logs': activityLogsPage, backups: backupsPage };
    if (pages[page]) pages[page]();
}

// ─── DASHBOARD ───
// BACKUP & RESTORE
async function backupsPage() {
    if (currentUser.role_name !== 'Super Admin') {
        document.getElementById('page-content').innerHTML = '<div class="alert alert-error">Only Super Admin can access Backup & Restore.</div>';
        return;
    }

    const pageEl = document.getElementById('page-content');
    pageEl.innerHTML = '<div class="empty-state"><div class="empty-icon">B</div><p>Loading backup history...</p></div>';

    try {
        const data = await API.get('/backups');
        if (!data.success) {
            pageEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to load backups.')}</div>`;
            return;
        }

        pageEl.innerHTML = `
            <div class="backup-layout">
                <div class="backup-hero card">
                    <div class="backup-hero-copy">
                        <span class="backup-kicker">System safety</span>
                        <h2>Database Backup & Restore</h2>
                        <p>Create server-stored snapshots of tickets, assets, users, logs, notifications, roles, categories, and settings. Restore is protected by exact filename confirmation.</p>
                    </div>
                    <div class="backup-actions">
                        <button class="btn btn-primary" id="create-backup-btn" onclick="createBackup()">Create Manual Backup</button>
                    </div>
                </div>
                <div id="backup-alert"></div>
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">Backup History</span>
                        <span style="font-size:12px;color:var(--text-muted);">${data.backups.length} files</span>
                    </div>
                    <div class="table-wrapper">
                        ${data.backups.length ? renderBackupHistory(data.backups) : `
                            <div class="empty-state">
                                <div class="empty-icon">B</div>
                                <h3>No backups yet</h3>
                                <p>Create a manual backup to start your restore history.</p>
                            </div>
                        `}
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        pageEl.innerHTML = '<div class="alert alert-error">Unable to load backups. Please try again.</div>';
    }
}

function renderBackupHistory(backups) {
    return `
        <table>
            <thead>
                <tr>
                    <th>Backup File</th>
                    <th>Generated</th>
                    <th>Size</th>
                    <th>Created By</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                ${backups.map(backup => `
                    <tr>
                        <td>
                            <strong>${escHtml(backup.file_name)}</strong>
                            ${backup.invalid ? '<div class="backup-warning">Invalid backup metadata</div>' : ''}
                        </td>
                        <td>${formatDate(backup.generated_at || backup.modified_at)}</td>
                        <td>${formatFileSize(backup.size || 0)}</td>
                        <td>${escHtml(backup.generated_by?.user_name || '-')}</td>
                        <td>
                            <button class="btn btn-secondary btn-sm" ${backup.invalid ? 'disabled' : ''} onclick="openRestoreBackupModal('${escHtml(backup.file_name)}')">Restore</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

async function createBackup() {
    const button = document.getElementById('create-backup-btn');
    const alertEl = document.getElementById('backup-alert');
    button.disabled = true;
    button.textContent = 'Creating backup...';
    alertEl.innerHTML = '';

    try {
        const data = await API.post('/backups', {});
        if (data.success) {
            showToast('Backup created successfully.', 'success');
            alertEl.innerHTML = `<div class="alert alert-success">Backup created: ${escHtml(data.backup.file_name)}</div>`;
            await backupsPage();
        } else {
            alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Backup failed.')}</div>`;
        }
    } catch (err) {
        alertEl.innerHTML = '<div class="alert alert-error">Backup failed. Please try again.</div>';
    } finally {
        button.disabled = false;
        button.textContent = 'Create Manual Backup';
    }
}

function openRestoreBackupModal(fileName) {
    const html = `
        <div class="modal-overlay active" id="restore-backup-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">Restore Database Backup</span>
                    <button class="modal-close" onclick="closeModal('restore-backup-modal')">x</button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-error">
                        Restore will replace current system data with the selected backup. Create a fresh backup first if you need a rollback point.
                    </div>
                    <div class="form-group">
                        <label class="form-label">Selected backup</label>
                        <input class="form-input" id="restore-file-name" value="${escHtml(fileName)}" readonly>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Type the exact backup filename to confirm</label>
                        <input class="form-input" id="restore-confirmation" placeholder="${escHtml(fileName)}">
                    </div>
                    <div id="restore-backup-alert"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('restore-backup-modal')">Cancel</button>
                    <button class="btn btn-danger" id="restore-backup-btn" onclick="restoreBackup()">Restore Database</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

async function restoreBackup() {
    const fileName = document.getElementById('restore-file-name')?.value;
    const confirmation = document.getElementById('restore-confirmation')?.value;
    const alertEl = document.getElementById('restore-backup-alert');
    const button = document.getElementById('restore-backup-btn');

    if (confirmation !== fileName) {
        alertEl.innerHTML = '<div class="alert alert-error">Confirmation does not match the backup filename.</div>';
        return;
    }

    button.disabled = true;
    button.textContent = 'Restoring...';
    try {
        const data = await API.post('/backups/restore', { file_name: fileName, confirmation });
        if (data.success) {
            alertEl.innerHTML = '<div class="alert alert-success">Database restored successfully.</div>';
            showToast('Database restored successfully.', 'success');
            setTimeout(() => {
                closeModal('restore-backup-modal');
                backupsPage();
            }, 900);
        } else {
            alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Restore failed.')}</div>`;
        }
    } catch (err) {
        alertEl.innerHTML = '<div class="alert alert-error">Restore failed. No changes were committed.</div>';
    } finally {
        button.disabled = false;
        button.textContent = 'Restore Database';
    }
}

function canViewDashboardAnalytics() {
    return ['Super Admin', 'Admin'].includes(currentUser?.role_name);
}

function dashboardEmptyState(title, message = 'No data available yet.') {
    return `<div class="empty-state dashboard-empty"><h3>${escHtml(title)}</h3><p>${escHtml(message)}</p></div>`;
}

function chartColor(label) {
    const colors = {
        Open: 'var(--accent)',
        'In Progress': 'var(--warning)',
        Pending: 'var(--warning)',
        Resolved: 'var(--success)',
        Closed: 'var(--text-muted)',
        Low: 'var(--text-muted)',
        Normal: 'var(--accent)',
        Medium: 'var(--accent)',
        High: 'var(--warning)',
        Urgent: 'var(--danger)',
        Critical: 'var(--danger)',
        Available: 'var(--success)',
        Assigned: 'var(--accent)',
        'For Inspection': 'var(--warning)',
        Returned: 'var(--text-muted)',
        'Pulled Out': 'var(--warning)',
        'Under Repair': 'var(--warning)',
        Retired: 'var(--text-muted)',
        Lost: 'var(--danger)'
    };
    return colors[label] || 'var(--accent)';
}

function renderTicketSummaryCards(tickets = {}, kpis = {}) {
    const resolvedClosed = (tickets.resolved || 0) + (tickets.closed || 0);
    const cards = [
        { label: 'Total Tickets', value: tickets.total || 0, className: '', icon: 'T' },
        { label: 'Open', value: tickets.open || 0, className: 'accent', icon: 'O' },
        { label: 'Pending', value: tickets.pending || 0, className: 'warning', icon: 'P' },
        { label: 'Resolved / Closed', value: resolvedClosed, className: 'success', icon: 'R' },
        { label: 'Urgent Open', value: tickets.urgentOpen || 0, className: 'danger', icon: 'U' },
        { label: 'Average Acknowledgement Time', value: formatDuration(kpis.avgAcknowledgementMinutes), className: 'accent', icon: 'A' },
        { label: 'Average Resolution Time', value: formatDuration(kpis.avgResolutionMinutes), className: 'success', icon: 'R' },
        { label: 'Total Resolved Tickets', value: kpis.totalResolvedTickets || 0, className: 'success', icon: 'T' },
        { label: 'Overdue Tickets', value: kpis.overdueTickets || 0, className: (kpis.overdueTickets || 0) ? 'danger' : '', icon: 'O' }
    ];

    return `
        <div class="stats-grid dashboard-summary dashboard-overview-grid">
            ${cards.map(card => `
                <div class="stat-card ${card.className}">
                    <div class="stat-icon stat-letter">${card.icon}</div>
                    <div class="stat-label">${card.label}</div>
                    <div class="stat-value">${card.value}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderAssetSummaryCards(assets = {}) {
    const cards = [
        { label: 'Total Assets', value: assets.total || 0, className: '', icon: 'A' },
        { label: 'Available', value: assets.available || 0, className: 'success', icon: 'V' },
        { label: 'Assigned', value: assets.assigned || 0, className: 'accent', icon: 'S' },
        { label: 'For Inspection', value: assets.forInspection || 0, className: 'warning', icon: 'I' },
        { label: 'Returned', value: assets.returned || 0, className: '', icon: 'R' },
        { label: 'Pulled Out', value: assets.pulledOut || 0, className: 'warning', icon: 'P' }
    ];

    return `
        <div class="stats-grid dashboard-summary dashboard-asset-grid">
            ${cards.map(card => `
                <div class="stat-card ${card.className}">
                    <div class="stat-icon stat-letter">${card.icon}</div>
                    <div class="stat-label">${card.label}</div>
                    <div class="stat-value">${card.value}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderHorizontalBars(items, labelKey, valueKey = 'count') {
    const max = Math.max(...items.map(item => Number(item[valueKey]) || 0), 0);
    if (!items.length || max === 0) return dashboardEmptyState('No chart data');

    return `
        <div class="bar-chart">
            ${items.map(item => {
                const label = item[labelKey] || 'Unknown';
                const value = Number(item[valueKey]) || 0;
                const width = max ? Math.max((value / max) * 100, value ? 4 : 0) : 0;
                return `
                    <div class="bar-row">
                        <div class="bar-label">${escHtml(label)}</div>
                        <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${chartColor(label)};"></div></div>
                        <div class="bar-value">${value}</div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderDonutChart(items, labelKey, centerLabel = 'items') {
    const total = items.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    if (!items.length || total === 0) return dashboardEmptyState('No chart data');

    let offset = 0;
    const radius = 58;
    const circumference = 2 * Math.PI * radius;
    const segments = items.map(item => {
        const value = Number(item.count) || 0;
        const dash = (value / total) * circumference;
        const label = item[labelKey] || 'Unknown';
        const segment = `<circle r="${radius}" cx="80" cy="80" fill="none" stroke="${chartColor(label)}" stroke-width="18" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 80 80)" />`;
        offset += dash;
        return segment;
    }).join('');

    return `
        <div class="donut-chart">
            <svg viewBox="0 0 160 160" role="img" aria-label="${escHtml(centerLabel)} by status">
                <circle r="${radius}" cx="80" cy="80" fill="none" stroke="var(--bg-input)" stroke-width="18" />
                ${segments}
                <text x="80" y="76" text-anchor="middle" class="donut-total">${total}</text>
                <text x="80" y="96" text-anchor="middle" class="donut-label">${escHtml(centerLabel)}</text>
            </svg>
            <div class="chart-legend">
                ${items.map(item => {
                    const label = item[labelKey] || 'Unknown';
                    return `<span><i style="background:${chartColor(label)}"></i>${escHtml(label)} (${item.count || 0})</span>`;
                }).join('')}
            </div>
        </div>
    `;
}

function renderLineChart(items, label = 'Monthly trend') {
    const values = items.map(item => Number(item.count) || 0);
    const max = Math.max(...values, 0);
    if (!items.length || max === 0) return dashboardEmptyState('No monthly data');

    const width = 520;
    const height = 210;
    const left = 34;
    const right = 18;
    const top = 18;
    const bottom = 38;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const step = items.length > 1 ? innerWidth / (items.length - 1) : innerWidth;
    const points = items.map((item, index) => {
        const x = left + index * step;
        const y = top + innerHeight - ((Number(item.count) || 0) / max) * innerHeight;
        return { x, y, label: item.month, count: Number(item.count) || 0 };
    });
    const areaPoints = `${left},${top + innerHeight} ${points.map(p => `${p.x},${p.y}`).join(' ')} ${left + innerWidth},${top + innerHeight}`;

    return `
        <div class="line-chart">
            <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escHtml(label)}">
                <polyline points="${areaPoints}" fill="var(--accent-light)" stroke="none"></polyline>
                <polyline points="${points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
                ${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--bg-card)" stroke="var(--accent)" stroke-width="3"><title>${escHtml(p.label)}: ${p.count}</title></circle>`).join('')}
                ${points.map((p, index) => index % Math.ceil(points.length / 6) === 0 || index === points.length - 1 ? `<text x="${p.x}" y="${height - 12}" text-anchor="middle" class="axis-label">${escHtml(p.label)}</text>` : '').join('')}
            </svg>
        </div>
    `;
}

function renderDualLineChart(primaryItems, secondaryItems) {
    const months = [...primaryItems, ...secondaryItems]
        .map(item => `${item.year || ''}-${item.month}`)
        .filter((value, index, list) => list.indexOf(value) === index);
    const rows = months.map(key => {
        const [, month] = key.split('-');
        const primary = primaryItems.find(item => `${item.year || ''}-${item.month}` === key);
        const secondary = secondaryItems.find(item => `${item.year || ''}-${item.month}` === key);
        return {
            month,
            assigned: Number(primary?.count) || 0,
            returned: Number(secondary?.count) || 0
        };
    });
    const max = Math.max(...rows.map(item => Math.max(item.assigned, item.returned)), 0);
    if (!rows.length || max === 0) return dashboardEmptyState('No assignment trends');

    const width = 520;
    const height = 210;
    const left = 34;
    const right = 18;
    const top = 18;
    const bottom = 44;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const step = rows.length > 1 ? innerWidth / (rows.length - 1) : innerWidth;
    const pointsFor = (key) => rows.map((item, index) => {
        const x = left + index * step;
        const y = top + innerHeight - (item[key] / max) * innerHeight;
        return { x, y, month: item.month, count: item[key] };
    });
    const assignedPoints = pointsFor('assigned');
    const returnedPoints = pointsFor('returned');

    return `
        <div class="line-chart stacked-line-chart">
            <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Asset assignments and returns per month">
                <polyline points="${assignedPoints.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
                <polyline points="${returnedPoints.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="var(--warning)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
                ${assignedPoints.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--bg-card)" stroke="var(--accent)" stroke-width="3"><title>${escHtml(p.month)} assigned: ${p.count}</title></circle>`).join('')}
                ${returnedPoints.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--bg-card)" stroke="var(--warning)" stroke-width="3"><title>${escHtml(p.month)} returned: ${p.count}</title></circle>`).join('')}
                ${rows.map((row, index) => index % Math.ceil(rows.length / 6) === 0 || index === rows.length - 1 ? `<text x="${left + index * step}" y="${height - 18}" text-anchor="middle" class="axis-label">${escHtml(row.month)}</text>` : '').join('')}
            </svg>
            <div class="chart-legend chart-legend-inline">
                <span><i style="background:var(--accent)"></i>Assigned</span>
                <span><i style="background:var(--warning)"></i>Returned</span>
            </div>
        </div>
    `;
}

function renderRecentAssetList(items, dateKey, emptyTitle) {
    if (!items.length) return dashboardEmptyState(emptyTitle);

    return `
        <div class="asset-activity-list">
            ${items.map(item => `
                <div class="asset-activity-item">
                    <div>
                        <strong>${escHtml(item.asset_tag || '-')}</strong>
                        <span>${escHtml(item.asset_name || 'Unnamed asset')}</span>
                    </div>
                    <div>
                        <span>${escHtml(item.assigned_to_name || 'Unassigned')}</span>
                        <small>${formatDate(item[dateKey])}</small>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderAnalyticsDashboard(data) {
    return `
        <div class="dashboard-shell">
        <section class="dashboard-section dashboard-section-compact">
            <div class="dashboard-section-header">
                <div>
                    <h2>Ticket Analytics</h2>
                    <p>Operational overview of ticket volume, status, priority, and creation trends.</p>
                </div>
            </div>
        </section>
        ${renderTicketSummaryCards(data.tickets, data.ticketKpis)}
        <div class="dashboard-charts-grid ticket-dashboard-grid">
            <div class="card chart-card chart-card-large">
                <div class="card-header"><span class="card-title">Tickets Created Per Month</span></div>
                <div class="card-body">${renderLineChart(data.ticketsPerMonth || [], 'Tickets created per month')}</div>
            </div>
            <div class="card chart-card">
                <div class="card-header"><span class="card-title">Tickets by Status</span></div>
                <div class="card-body">${renderDonutChart(data.ticketsByStatus || [], 'status', 'tickets')}</div>
            </div>
            <div class="card chart-card">
                <div class="card-header"><span class="card-title">Tickets by Priority</span></div>
                <div class="card-body">${renderHorizontalBars(data.ticketsByPriority || [], 'priority')}</div>
            </div>
        </div>

        <section class="dashboard-section dashboard-section-compact">
            <div class="dashboard-section-header">
                <div>
                    <h2>Asset Analytics</h2>
                    <p>Inventory health, allocation status, category mix, and assignment movement.</p>
                </div>
            </div>
        </section>
        ${renderAssetSummaryCards(data.assets)}
        <div class="dashboard-charts-grid asset-dashboard-grid">
            <div class="card chart-card">
                <div class="card-header"><span class="card-title">Assets by Status</span></div>
                <div class="card-body">${renderDonutChart(data.assetsByStatus || [], 'status', 'assets')}</div>
            </div>
            <div class="card chart-card">
                <div class="card-header"><span class="card-title">Assets by Category</span></div>
                <div class="card-body">${renderHorizontalBars(data.assetsByCategory || [], 'category')}</div>
            </div>
            <div class="card chart-card chart-card-large">
                <div class="card-header"><span class="card-title">Asset Assignment Trends</span></div>
                <div class="card-body">${renderDualLineChart(data.assetAssignmentsPerMonth || [], data.assetReturnsPerMonth || [])}</div>
            </div>
            <div class="card chart-card">
                <div class="card-header"><span class="card-title">Recently Assigned</span></div>
                <div class="card-body">${renderRecentAssetList(data.recentlyAssignedAssets || [], 'assigned_at', 'No recent assignments')}</div>
            </div>
            <div class="card chart-card">
                <div class="card-header"><span class="card-title">Recently Returned</span></div>
                <div class="card-body">${renderRecentAssetList(data.recentlyReturnedAssets || [], 'returned_at', 'No recent returns')}</div>
            </div>
        </div>
        </div>
    `;
}

async function dashboard() {
    const pageEl = document.getElementById('page-content');
    const showAnalytics = canViewDashboardAnalytics();
    const recentTicketsEndpoint = currentUser.can_view_all_tickets
        ? '/tickets?limit=10'
        : `/tickets?limit=10&created_by=${currentUser.user_id}`;
    const loadingAnalytics = showAnalytics ? '<div class="card"><div class="card-body"><div class="empty-state"><p>Loading dashboard analytics...</p></div></div></div>' : '';
    pageEl.innerHTML = loadingAnalytics;

    try {
        const requests = [API.get(recentTicketsEndpoint)];
        if (showAnalytics) requests.unshift(API.get('/dashboard/stats'));
        const results = await Promise.all(requests);
        const dashboardData = showAnalytics ? results[0] : null;
        const ticketsData = showAnalytics ? results[1] : results[0];
        const tks = ticketsData.tickets || [];
        const analyticsHtml = showAnalytics
            ? (dashboardData.success === false
                ? `<div class="alert alert-error">${escHtml(dashboardData.message || 'Unable to load dashboard analytics.')}</div>`
                : renderAnalyticsDashboard(dashboardData))
            : '';

        pageEl.innerHTML = `
            ${analyticsHtml}
            <div class="card dashboard-recent-card">
                <div class="card-header">
                    <span class="card-title">Recent Tickets</span>
                    <button class="btn btn-secondary btn-sm" onclick="navigateTo('${currentUser.can_assign_tickets ? 'tickets' : 'my-tickets'}')">View All</button>
                </div>
                <div class="table-wrapper table-wrapper-scroll">
                    ${tks.length ? renderTicketTable(tks) : dashboardEmptyState('No recent tickets', 'Created tickets will appear here.')}
                </div>
            </div>
        `;
    } catch (err) {
        pageEl.innerHTML = `
            <div class="alert alert-error">Unable to load dashboard. Please try again.</div>
            <div class="card"><div class="card-body">${dashboardEmptyState('Dashboard unavailable')}</div></div>
        `;
    }
}

// ─── TICKETS LIST ───
async function tickets(assignedFilter = '') {
    if (assignedFilter) navigateTo('tickets');
    await renderTicketList({ assigned: assignedFilter });
}

async function renderTicketList(filters = {}) {
    currentTicketFilters = { ...filters };
    const pageEl = document.getElementById('page-content');

    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.assigned) params.set('assigned', filters.assigned);
    if (filters.created_by) params.set('created_by', filters.created_by);
    if (filters.mine) params.set('mine', filters.mine);
    if (filters.search) params.set('search', filters.search);
    if (filters.page) params.set('page', filters.page);

    const data = await API.get(`/tickets?${params}`);
    const tks = data.tickets || [];

    pageEl.innerHTML = `
        <div class="filters-bar">
            ${mobileFilterToggleMarkup('Filters')}
            <div class="mobile-filter-panel" onclick="event.stopPropagation()">
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
        </div>

        <div class="card ticket-list-card">
            <div class="table-wrapper table-wrapper-scroll">
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
    renderTicketList({ ...currentTicketFilters, search, status, priority, assigned, page: undefined });
}

function refreshActiveTicketList() {
    if (!['tickets', 'my-tickets'].includes(currentPage)) return;
    renderTicketList(currentTicketFilters);
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
                    <th>SLA</th>
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
                        <td>${slaStatusBadge(t.sla_status)}</td>
                        <td>${t.assigned_to_name ? `<div class="user-name-with-status"><span>${escHtml(t.assigned_to_name)}</span>${profileStatusBadge(t.assigned_to_status, true)}</div>` : '<span style="color:var(--text-muted);font-size:12px;">Unassigned</span>'}</td>
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
    await renderTicketList({ mine: '1' });
}

// ─── ACTIVITY LOGS ───
async function activityLogsPage(filters = currentActivityLogFilters) {
    currentActivityLogFilters = filters || {};
    const pageEl = document.getElementById('page-content');
    pageEl.innerHTML = '<div class="empty-state"><div class="empty-icon">L</div><p>Loading activity logs...</p></div>';

    const params = new URLSearchParams();
    if (currentActivityLogFilters.search) params.set('search', currentActivityLogFilters.search);
    if (currentActivityLogFilters.module) params.set('module', currentActivityLogFilters.module);
    if (currentActivityLogFilters.date) params.set('date', currentActivityLogFilters.date);
    if (currentActivityLogFilters.page) params.set('page', currentActivityLogFilters.page);

    try {
        const data = await API.get(`/activity-logs?${params}`);
        if (!data.success) {
            pageEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to load activity logs.')}</div>`;
            return;
        }

        const logs = data.logs || [];
        pageEl.innerHTML = `
            <div class="filters-bar">
                ${mobileFilterToggleMarkup('Filters')}
                <div class="mobile-filter-panel" onclick="event.stopPropagation()">
                    <div class="search-input-wrap">
                        <span class="search-icon">🔍</span>
                        <input type="text" placeholder="Search user, action, details..." id="activity-search" value="${escHtml(currentActivityLogFilters.search || '')}">
                    </div>
                    <select class="filter-select" id="activity-module" onchange="applyActivityLogFilters()">
                        <option value="">All modules</option>
                        ${(data.modules || []).map(module => `<option value="${escHtml(module)}" ${currentActivityLogFilters.module === module ? 'selected' : ''}>${escHtml(module)}</option>`).join('')}
                    </select>
                    <input type="date" class="filter-select" id="activity-date" value="${escHtml(currentActivityLogFilters.date || '')}" onchange="applyActivityLogFilters()">
                    <button class="btn btn-secondary btn-sm" onclick="clearActivityLogFilters()">Clear</button>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-title">Audit Trail</span>
                    <span style="font-size:12px;color:var(--text-muted);">${data.total || 0} records</span>
                </div>
                <div class="table-wrapper">
                    ${logs.length ? renderActivityLogTable(logs) : '<div class="empty-state"><div class="empty-icon">L</div><h3>No activity logs found</h3><p>Try adjusting your filters.</p></div>'}
                </div>
                ${data.total > data.limit ? renderActivityLogPagination(data.page, Math.ceil(data.total / data.limit), data.total) : ''}
            </div>
        `;

        let searchTimer;
        document.getElementById('activity-search')?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => applyActivityLogFilters(), 400);
        });
    } catch (err) {
        pageEl.innerHTML = '<div class="alert alert-error">Unable to load activity logs. Please try again.</div>';
    }
}

// ─── REPORTS EXPORT ───
async function reportsPage() {
    if (!['Super Admin', 'Admin'].includes(currentUser.role_name)) {
        document.getElementById('page-content').innerHTML = '<div class="alert alert-error">Insufficient permissions.</div>';
        return;
    }

    const [ticketCats, assetCats] = await Promise.all([
        API.get('/users/categories'),
        assetRequest('GET', '/categories')
    ]);
    const ticketCategoryOptions = (ticketCats.categories || []).map(c => `<option value="${c.category_id}">${escHtml(c.category_name)}</option>`).join('');
    const assetCategoryOptions = (assetCats.categories || []).map(c => `<option value="${c.category_id}">${escHtml(c.category_name)}</option>`).join('');

    document.getElementById('page-content').innerHTML = `
        <div class="card">
            <div class="card-header">
                <span class="card-title">Report Filters</span>
                <span style="font-size:12px;color:var(--text-muted);">PDF and Excel exports</span>
            </div>
            <div class="card-body">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Report Type</label>
                        <select class="form-select" id="report-type" onchange="updateReportFilterOptions()">
                            <option value="tickets">Tickets</option>
                            <option value="assets">Assets</option>
                            <option value="assigned-assets">Assigned Assets</option>
                            <option value="returned-assets">Returned Assets</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Date From</label>
                        <input type="date" class="form-input" id="report-date-from">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Date To</label>
                        <input type="date" class="form-input" id="report-date-to">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Status</label>
                        <select class="form-select" id="report-status"></select>
                    </div>
                    <div class="form-group" id="report-priority-wrap">
                        <label class="form-label">Priority</label>
                        <select class="form-select" id="report-priority">
                            <option value="">All priorities</option>
                            <option value="Urgent">Urgent</option>
                            <option value="High">High</option>
                            <option value="Normal">Normal</option>
                            <option value="Low">Low</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Category</label>
                        <select class="form-select" id="report-category" data-ticket-options="${escHtml(ticketCategoryOptions)}" data-asset-options="${escHtml(assetCategoryOptions)}"></select>
                    </div>
                </div>
                <div class="report-actions">
                    <button class="btn btn-primary" id="export-pdf-btn" onclick="exportReport('pdf')">Export PDF</button>
                    <button class="btn btn-secondary" id="export-xlsx-btn" onclick="exportReport('xlsx')">Export Excel</button>
                </div>
                <div id="report-export-alert" style="margin-top:12px;"></div>
            </div>
        </div>
        <div class="card" style="margin-top:16px;">
            <div class="card-body">
                <div style="font-size:13px;color:var(--text-secondary);line-height:1.7;">
                    Reports include HelpDesk system name, generated date, active filters, summary totals, and table data from the database.
                </div>
            </div>
        </div>
    `;
    updateReportFilterOptions();
}

function updateReportFilterOptions() {
    const type = document.getElementById('report-type')?.value || 'tickets';
    const isTickets = type === 'tickets';
    const status = document.getElementById('report-status');
    const category = document.getElementById('report-category');
    const priorityWrap = document.getElementById('report-priority-wrap');

    const ticketStatuses = ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed'];
    const assetStatuses = ['Available', 'Assigned', 'For Inspection', 'Under Repair', 'Returned', 'Pulled Out', 'Retired', 'Lost'];
    status.innerHTML = `<option value="">All statuses</option>${(isTickets ? ticketStatuses : assetStatuses).map(s => `<option value="${s}">${s}</option>`).join('')}`;
    category.innerHTML = `<option value="">All categories</option>${isTickets ? category.dataset.ticketOptions : category.dataset.assetOptions}`;
    priorityWrap.style.display = isTickets ? '' : 'none';
}

async function exportReport(format) {
    const type = document.getElementById('report-type')?.value;
    const params = new URLSearchParams({ type, format });
    const dateFrom = document.getElementById('report-date-from')?.value;
    const dateTo = document.getElementById('report-date-to')?.value;
    const status = document.getElementById('report-status')?.value;
    const priority = document.getElementById('report-priority')?.value;
    const category = document.getElementById('report-category')?.value;
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (status) params.set('status', status);
    if (type === 'tickets' && priority) params.set('priority', priority);
    if (category) params.set('category_id', category);

    const button = document.getElementById(format === 'pdf' ? 'export-pdf-btn' : 'export-xlsx-btn');
    const alertEl = document.getElementById('report-export-alert');
    const originalText = button?.textContent || 'Export';
    if (button) {
        button.disabled = true;
        button.textContent = 'Preparing...';
    }
    if (alertEl) alertEl.innerHTML = '';

    try {
        const response = await fetch(`/api/reports/export?${params}`, { credentials: 'include' });
        if (!response.ok) {
            let message = 'Unable to export report.';
            try {
                const error = await response.json();
                message = error.message || message;
            } catch (err) {}
            if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${escHtml(message)}</div>`;
            return;
        }

        const blob = await response.blob();
        if (!blob.size) {
            if (alertEl) alertEl.innerHTML = '<div class="alert alert-error">Export returned an empty file.</div>';
            return;
        }

        const disposition = response.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/i);
        const fallbackName = `${type || 'report'}.${format}`;
        const fileName = match?.[1] || fallbackName;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        if (alertEl) alertEl.innerHTML = '<div class="alert alert-success">Report exported successfully.</div>';
    } catch (err) {
        if (alertEl) alertEl.innerHTML = '<div class="alert alert-error">Unable to export report. Please try again.</div>';
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

function applyActivityLogFilters(page = 1) {
    activityLogsPage({
        search: document.getElementById('activity-search')?.value?.trim(),
        module: document.getElementById('activity-module')?.value,
        date: document.getElementById('activity-date')?.value,
        page
    });
}

function clearActivityLogFilters() {
    currentActivityLogFilters = {};
    activityLogsPage({});
}

function renderActivityLogTable(logs) {
    return `
        <table>
            <thead>
                <tr>
                    <th>Timestamp</th>
                    <th>User</th>
                    <th>Role</th>
                    <th>Module</th>
                    <th>Action</th>
                    <th>Record</th>
                    <th>Details</th>
                </tr>
            </thead>
            <tbody>
                ${logs.map(log => `
                    <tr>
                        <td style="color:var(--text-muted);font-size:12px;">${formatDate(log.created_at)}</td>
                        <td><strong>${escHtml(log.user_name)}</strong></td>
                        <td>${escHtml(log.user_role)}</td>
                        <td><span class="activity-module-badge">${escHtml(log.module)}</span></td>
                        <td>${escHtml(log.action)}</td>
                        <td>${escHtml(log.record_id || '-')}</td>
                        <td class="activity-details">${formatActivityDetails(log.details)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function formatActivityDetails(details) {
    if (!details) return '<span style="color:var(--text-muted);">-</span>';
    try {
        const parsed = JSON.parse(details);
        return escHtml(Object.entries(parsed).map(([key, value]) => `${key}: ${value}`).join(', '));
    } catch (err) {
        return escHtml(details);
    }
}

function renderActivityLogPagination(page, totalPages, total) {
    return `
        <div class="pagination">
            <span>${total} total logs</span>
            <div class="pagination-pages">
                ${page > 1 ? `<button class="page-btn" onclick="applyActivityLogFilters(${page - 1})">‹</button>` : ''}
                ${Array.from({length: Math.min(totalPages, 7)}, (_, i) => i + 1).map(p =>
                    `<button class="page-btn ${p === page ? 'active' : ''}" onclick="applyActivityLogFilters(${p})">${p}</button>`
                ).join('')}
                ${page < totalPages ? `<button class="page-btn" onclick="applyActivityLogFilters(${page + 1})">›</button>` : ''}
            </div>
        </div>
    `;
}

// ─── TICKET DETAIL ───
async function openTicket(ticketId) {
    const data = await API.get(`/tickets/${ticketId}`);
    if (!data.success) return showToast(data.message, 'error');

    const { ticket: t, attachments, comments, history } = data;
    const transferHistory = data.transfer_history || [];
    const linkedAssets = data.linked_assets || data.assets || [];
    const linkedAsset = linkedAssets[0] || null;
    const assetData = await assetRequest('GET', '/');
    const ticketAssetOptions = `<option value="">No linked asset</option>` +
        (assetData.assets || []).map(a => `<option value="${a.asset_id}" ${linkedAsset && linkedAsset.asset_id === a.asset_id ? 'selected' : ''}>${escHtml(a.asset_tag)} - ${escHtml(a.asset_name)}</option>`).join('');

    let staffOptions = '';
    let transferStaff = [];
    if (currentUser.can_assign_tickets) {
        const staffData = await API.get('/users/staff');
        transferStaff = staffData.staff || [];
        staffOptions = `<option value="">Unassigned</option>` +
            transferStaff.map(s => `<option value="${s.user_id}" ${t.assigned_to_id == s.user_id ? 'selected' : ''}>${escHtml(s.full_name)} (${escHtml(s.role_name)} - ${escHtml(normalizeProfileStatus(s.profile_status))})</option>`).join('');
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
                                <div class="ticket-description">${escHtml(t.description)}</div>

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

                                ${linkedAsset ? `
                                <div style="margin-bottom:20px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;">
                                    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px;">
                                        <div>
                                            <div class="form-label" style="margin-bottom:2px;">Linked Asset</div>
                                            <div class="ticket-link" onclick="closeModal('ticket-modal');openAssetDetails(${linkedAsset.asset_id})" style="cursor:pointer;">${escHtml(linkedAsset.asset_tag)} - ${escHtml(linkedAsset.asset_name)}</div>
                                        </div>
                                        ${assetStatusBadge(linkedAsset.status)}
                                    </div>
                                    <div class="form-row" style="margin-bottom:0;">
                                        ${assetMetaBlock('Category', linkedAsset.category_name)}
                                        ${assetMetaBlock('Assigned To', linkedAsset.assigned_to_name)}
                                        ${assetMetaBlock('Brand / Model', [linkedAsset.brand, linkedAsset.model].filter(Boolean).join(' '))}
                                        ${assetMetaBlock('Location', linkedAsset.location)}
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
                                ${transferHistory.length ? `
                                <div style="margin-bottom:18px;">
                                    <div class="form-label">Transfer History</div>
                                    <div style="display:flex;flex-direction:column;gap:8px;">
                                        ${transferHistory.map(tr => `
                                            <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;background:var(--bg);">
                                                <div class="user-name-with-status" style="font-size:13px;margin-bottom:6px;">
                                                    <strong>${escHtml(tr.previous_assignee_name || 'Unassigned')}</strong>
                                                    <span style="color:var(--text-muted);">to</span>
                                                    <strong>${escHtml(tr.new_assignee_name || 'Unknown')}</strong>
                                                </div>
                                                <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">
                                                    Transferred by ${escHtml(tr.transferred_by_name || 'Unknown')} | ${formatDate(tr.transferred_at)}
                                                </div>
                                                <div style="font-size:12.5px;color:var(--text-primary);margin-top:6px;line-height:1.5;">${escHtml(tr.transfer_reason)}</div>
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>` : ''}
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
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">SLA Status</span>
                                    <span class="ticket-meta-value">${slaStatusBadge(t.sla_status)}</span>
                                </div>
                                ${t.acknowledged_at ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Acknowledged</span>
                                    <span class="ticket-meta-value">${formatDate(t.acknowledged_at)}</span>
                                </div>` : ''}
                                ${t.time_to_acknowledge_minutes !== null && t.time_to_acknowledge_minutes !== undefined ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Time to Acknowledge</span>
                                    <span class="ticket-meta-value">${formatDuration(t.time_to_acknowledge_minutes)}</span>
                                </div>` : ''}
                                ${t.due_date ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Due Date</span>
                                    <span class="ticket-meta-value" style="color:var(--warning);">${formatDate(t.due_date)}</span>
                                </div>` : ''}
                                ${t.resolved_at ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Resolved</span>
                                    <span class="ticket-meta-value" style="color:var(--success);">${formatDate(t.resolved_at)}</span>
                                </div>` : ''}
                                ${t.time_to_resolve_minutes !== null && t.time_to_resolve_minutes !== undefined ? `<div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Time to Resolve</span>
                                    <span class="ticket-meta-value">${formatDuration(t.time_to_resolve_minutes)}</span>
                                </div>` : ''}
                                ${currentUser.can_assign_tickets ? `
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Assigned To</span>
                                    <select class="form-select" style="margin-top:4px;" onchange="assignTicket(${t.ticket_id}, this.value)">
                                        ${staffOptions}
                                    </select>
                                    ${t.assigned_to_id ? `<button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%;justify-content:center;" onclick='openTransferTicketModal(${t.ticket_id}, ${t.assigned_to_id}, ${JSON.stringify(transferStaff).replace(/'/g, "&#39;")})'>Transfer Ticket</button>` : ''}
                                </div>` : `
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Assigned To</span>
                                    <span class="ticket-meta-value">${t.assigned_to_name ? `<span class="user-name-with-status">${escHtml(t.assigned_to_name)} ${profileStatusBadge(t.assigned_to_status, true)}</span>` : 'Unassigned'}</span>
                                </div>`}
                                <div class="ticket-meta-item">
                                    <span class="ticket-meta-label">Linked Asset</span>
                                    <select class="form-select" style="margin-top:4px;" onchange="updateTicketAsset(${t.ticket_id}, this.value)">
                                        ${ticketAssetOptions}
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

async function updateTicketAsset(ticketId, assetId) {
    const data = await API.patch(`/tickets/${ticketId}`, { asset_id: assetId || null });
    if (data.success) {
        closeModal('ticket-modal');
        showToast(assetId ? 'Asset linked!' : 'Asset unlinked!', 'success');
        openTicket(ticketId);
    } else {
        showToast(data.message, 'error');
    }
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

function openTransferTicketModal(ticketId, currentAssigneeId, staff = []) {
    const candidates = (staff || []).filter(user => Number(user.user_id) !== Number(currentAssigneeId));
    const options = candidates.map(user => {
        const status = normalizeProfileStatus(user.profile_status);
        const blocked = ['On Leave', 'Offline'].includes(status);
        return `<option value="${user.user_id}" data-status="${escHtml(status)}" ${blocked ? 'disabled' : ''}>${escHtml(user.full_name)} (${escHtml(user.role_name)} - ${escHtml(status)}${blocked ? ' unavailable' : ''})</option>`;
    }).join('');

    const html = `
        <div class="modal-overlay active" id="transfer-ticket-modal">
            <div class="modal" style="max-width:520px;">
                <div class="modal-header">
                    <span class="modal-title">Transfer Ticket</span>
                    <button class="modal-close" onclick="closeModal('transfer-ticket-modal')">x</button>
                </div>
                <div class="modal-body">
                    <div id="transfer-ticket-alert"></div>
                    <div class="form-group">
                        <label class="form-label">New Assignee <span class="required">*</span></label>
                        <select class="form-select" id="transfer-assignee" onchange="updateTransferAssigneeWarning()">
                            <option value="">Select staff...</option>
                            ${options || '<option value="" disabled>No other staff available</option>'}
                        </select>
                        <div class="form-hint" id="transfer-assignee-hint">Users who are On Leave or Offline cannot receive transferred tickets.</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Transfer Reason <span class="required">*</span></label>
                        <textarea class="form-textarea" id="transfer-reason" rows="4" placeholder="Why is this ticket being transferred?"></textarea>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('transfer-ticket-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitTicketTransfer(${ticketId})">Transfer</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

function updateTransferAssigneeWarning() {
    const select = document.getElementById('transfer-assignee');
    const hint = document.getElementById('transfer-assignee-hint');
    const status = select?.selectedOptions?.[0]?.dataset?.status;
    if (!hint) return;
    if (['On Leave', 'Offline'].includes(status)) {
        hint.textContent = `This user is ${status} and cannot receive a transfer.`;
        hint.style.color = 'var(--danger)';
    } else {
        hint.textContent = 'Users who are On Leave or Offline cannot receive transferred tickets.';
        hint.style.color = 'var(--text-muted)';
    }
}

async function submitTicketTransfer(ticketId) {
    const alertEl = document.getElementById('transfer-ticket-alert');
    const newAssignee = document.getElementById('transfer-assignee')?.value;
    const reason = document.getElementById('transfer-reason')?.value.trim();
    if (!newAssignee || !reason) {
        alertEl.innerHTML = '<div class="alert alert-error">Select a new assignee and enter a transfer reason.</div>';
        return;
    }

    const data = await API.post(`/tickets/${ticketId}/transfer`, {
        new_assignee: newAssignee,
        transfer_reason: reason
    });
    if (data.success) {
        closeModal('transfer-ticket-modal');
        closeModal('ticket-modal');
        showToast('Ticket transferred!', 'success');
        if (currentPage === 'dashboard') dashboard();
        else renderTicketList();
        openTicket(ticketId);
    } else {
        alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to transfer ticket.')}</div>`;
    }
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
    try {
    const [catData, deptData, assetData] = await Promise.all([
        safeJson('/users/categories', { categories: [] }),
        safeJson('/users/departments', { departments: [] }),
        assetRequest('GET', '/')
    ]);
    const cats = (catData.categories || []).filter(c => c.is_active);
    const depts = (deptData.departments || []).filter(d => d.is_active);
    const assets = assetData.assets || [];

    // If admin/staff, fetch all users for "Request by" dropdown
    let usersForRequest = [];
    if (currentUser.can_assign_tickets) {
        const ud = await safeJson('/users/all-users', { users: [] });
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
                            <label class="form-label">Linked Asset</label>
                            <select class="form-select" id="ct-asset">
                                <option value="">No linked asset</option>
                                ${assets.map(a => `<option value="${a.asset_id}">${escHtml(a.asset_tag)} - ${escHtml(a.asset_name)}${a.assigned_to_name ? ' (' + escHtml(a.assigned_to_name) + ')' : ''}</option>`).join('')}
                            </select>
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

    selectedFiles = [];
    document.getElementById('create-ticket-form').addEventListener('submit', submitCreateTicket);
    } catch (err) {
        console.error('Create ticket page error:', err);
        document.getElementById('page-content').innerHTML = `
            <div class="alert alert-error">
                Unable to load the New Ticket form. Please refresh and try again.
            </div>
        `;
    }
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
    fd.append('asset_id', document.getElementById('ct-asset')?.value || '');
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
function closeUserActionsMenu() {
    document.getElementById('user-actions-menu')?.remove();
    document.querySelectorAll('.user-actions-trigger.active').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-expanded', 'false');
    });
}

function positionUserActionsMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(190, window.innerWidth - 24);
    const viewportGap = 8;
    const height = Math.min(menu.offsetHeight || 140, Math.floor(window.innerHeight * 0.7));
    const left = Math.max(viewportGap, Math.min(rect.right - width, window.innerWidth - width - viewportGap));
    const spaceBelow = window.innerHeight - rect.bottom - viewportGap;
    const top = spaceBelow >= height
        ? rect.bottom + 6
        : Math.max(viewportGap, rect.top - height - 6);

    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function toggleUserActionsMenu(event, userId) {
    event?.preventDefault();
    event?.stopPropagation();
    const anchor = event?.currentTarget;
    const existing = document.getElementById('user-actions-menu');
    if (existing?.dataset.userId === String(userId)) {
        closeUserActionsMenu();
        return;
    }

    closeUserActionsMenu();
    const user = usersActionContext.usersById.get(Number(userId));
    if (!user || !anchor) return;
    anchor.classList.add('active');
    anchor.setAttribute('aria-expanded', 'true');

    const canToggleStatus = Number(user.user_id) !== Number(currentUser?.user_id);
    const menu = document.createElement('div');
    menu.id = 'user-actions-menu';
    menu.className = 'user-actions-menu';
    menu.dataset.userId = String(userId);
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <button class="user-actions-menu-item" onclick="handleUserTableAction('edit', ${user.user_id})" type="button" role="menuitem">Edit</button>
        <button class="user-actions-menu-item warning" onclick="handleUserTableAction('reset', ${user.user_id})" type="button" role="menuitem">Reset Password</button>
        ${canToggleStatus ? `<button class="user-actions-menu-item ${user.is_active ? 'danger' : 'success'}" onclick="handleUserTableAction('toggle', ${user.user_id})" type="button" role="menuitem">${user.is_active ? 'Deactivate' : 'Activate'}</button>` : ''}
    `;
    document.body.appendChild(menu);
    positionUserActionsMenu(menu, anchor);
}

function handleUserTableAction(action, userId) {
    const user = usersActionContext.usersById.get(Number(userId));
    if (!user) return closeUserActionsMenu();
    closeUserActionsMenu();
    if (action === 'edit') {
        openEditUserModal(user, usersActionContext.roles, usersActionContext.depts);
        return;
    }
    if (action === 'reset') {
        confirmResetPassword(user.user_id, user.full_name);
        return;
    }
    if (action === 'toggle') {
        toggleUserStatus(user.user_id, user.is_active);
    }
}

document.addEventListener('click', event => {
    const menu = document.getElementById('user-actions-menu');
    if (!menu) return;
    if (menu.contains(event.target) || event.target.closest?.('.user-actions-trigger')) return;
    closeUserActionsMenu();
});
window.addEventListener('resize', closeUserActionsMenu);
window.addEventListener('scroll', closeUserActionsMenu, true);

window.toggleUserActionsMenu = toggleUserActionsMenu;
window.handleUserTableAction = handleUserTableAction;

function userManagementSearchText(parts = []) {
    return escHtml(parts.filter(value => value !== null && value !== undefined).join(' ').toLowerCase());
}

function filterUserManagementTab(tabId) {
    const tab = document.getElementById(tabId);
    if (!tab) return;
    const input = tab.querySelector('[data-management-search]');
    const clearBtn = tab.querySelector('.management-search-clear');
    const query = (input?.value || '').trim().toLowerCase();
    const rows = Array.from(tab.querySelectorAll('.user-management-row'));
    let visibleCount = 0;

    rows.forEach(row => {
        const haystack = row.dataset.search || '';
        const visible = !query || haystack.includes(query);
        row.classList.toggle('hidden', !visible);
        if (visible) visibleCount += 1;
    });

    tab.querySelector('.user-management-empty-row')?.classList.toggle('hidden', visibleCount !== 0);
    if (clearBtn) clearBtn.classList.toggle('hidden', !query);
}

function clearUserManagementSearch(tabId) {
    const tab = document.getElementById(tabId);
    const input = tab?.querySelector('[data-management-search]');
    if (!input) return;
    input.value = '';
    filterUserManagementTab(tabId);
    input.focus();
}

window.filterUserManagementTab = filterUserManagementTab;
window.clearUserManagementSearch = clearUserManagementSearch;

function mobileFilterToggleMarkup(label = 'Filters') {
    return `
        <button class="mobile-filter-toggle" type="button" onclick="toggleMobileFilterPanel(event)" aria-expanded="false">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="21" y1="4" x2="14" y2="4"></line>
                <line x1="10" y1="4" x2="3" y2="4"></line>
                <line x1="21" y1="12" x2="12" y2="12"></line>
                <line x1="8" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="20" x2="16" y2="20"></line>
                <line x1="12" y1="20" x2="3" y2="20"></line>
                <circle cx="12" cy="4" r="2"></circle>
                <circle cx="10" cy="12" r="2"></circle>
                <circle cx="14" cy="20" r="2"></circle>
            </svg>
            <span>${escHtml(label)}</span>
        </button>
    `;
}

function toggleMobileFilterPanel(event) {
    event?.stopPropagation();
    const bar = event?.currentTarget?.closest('.filters-bar');
    if (!bar) return;

    document.querySelectorAll('.filters-bar.mobile-filter-open').forEach(openBar => {
        if (openBar !== bar) {
            openBar.classList.remove('mobile-filter-open');
            openBar.querySelector('.mobile-filter-toggle')?.setAttribute('aria-expanded', 'false');
        }
    });

    const isOpen = bar.classList.toggle('mobile-filter-open');
    event.currentTarget.setAttribute('aria-expanded', String(isOpen));
}

function closeMobileFilterPanels() {
    document.querySelectorAll('.filters-bar.mobile-filter-open').forEach(bar => {
        bar.classList.remove('mobile-filter-open');
        bar.querySelector('.mobile-filter-toggle')?.setAttribute('aria-expanded', 'false');
    });
}

document.addEventListener('click', (event) => {
    if (!event.target.closest('.filters-bar')) closeMobileFilterPanels();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMobileFilterPanels();
});

window.toggleMobileFilterPanel = toggleMobileFilterPanel;

async function usersPage() {
    closeUserActionsMenu();
    const [usersData, rolesData, catsData, deptsData] = await Promise.all([
        API.get('/users'), API.get('/users/roles'),
        API.get('/users/categories'), API.get('/users/departments')
    ]);
    if (usersData.success === false && !usersData.users) {
        currentUser.can_manage_users = false;
        setupNav();
        document.getElementById('page-content').innerHTML = `<div class="alert alert-error">${escHtml(usersData.message || 'Insufficient permissions.')}</div>`;
        return;
    }
    const users = usersData.users || [];
    const roles = rolesData.roles || [];
    const cats = catsData.categories || [];
    const depts = deptsData.departments || [];
    usersActionContext = {
        usersById: new Map(users.map(user => [Number(user.user_id), user])),
        roles,
        depts
    };

    document.getElementById('page-content').innerHTML = `
        <div class="tabs" style="margin-bottom:16px;">
            <button class="tab-btn active" onclick="switchUsersTab('tab-users')">👥 Users</button>
            <button class="tab-btn" onclick="switchUsersTab('tab-categories')">🗂 Categories</button>
            <button class="tab-btn" onclick="switchUsersTab('tab-departments')">🏢 Departments</button>
        </div>

        <div id="tab-users">
            <div class="card">
                <div class="card-header management-toolbar">
                    <button class="btn btn-primary btn-sm" onclick="openAddUserModal(${JSON.stringify(roles).replace(/"/g,'&quot;')}, ${JSON.stringify(depts).replace(/"/g,'&quot;')})">Add User</button>
                    <div class="search-input-wrap management-search-input">
                        <span class="search-icon">⌕</span>
                        <input data-management-search type="search" placeholder="Search users..." oninput="filterUserManagementTab('tab-users')" autocomplete="off">
                        <button class="management-search-clear hidden" onclick="clearUserManagementSearch('tab-users')" type="button" aria-label="Clear search">x</button>
                    </div>
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
                                <tr class="user-management-row" data-search="${userManagementSearchText([u.full_name, u.username, u.email, u.role_name, u.department, u.position, u.branch, u.phone])}">
                                    <td><div class="user-name-with-status"><strong>${escHtml(u.full_name)}</strong>${profileStatusBadge(u.profile_status, true)}</div>${u.must_change_password ? ' <span style="font-size:10px;color:var(--warning);">⚠ Must change pw</span>' : ''}</td>
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
                                        <button class="btn-icon user-actions-trigger" onclick="toggleUserActionsMenu(event, ${u.user_id})" type="button" aria-label="User actions" aria-haspopup="menu" aria-expanded="false">⋮</button>
                                    </td>
                                </tr>
                            `).join('')}
                            <tr class="user-management-empty-row hidden"><td colspan="11"><div class="table-empty-state">No users match your search.</div></td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div id="tab-categories" class="hidden">
            <div class="card">
                <div class="card-header management-toolbar">
                    <button class="btn btn-primary btn-sm" onclick="openCategoryModal()">New Category</button>
                    <div class="search-input-wrap management-search-input">
                        <span class="search-icon">⌕</span>
                        <input data-management-search type="search" placeholder="Search categories..." oninput="filterUserManagementTab('tab-categories')" autocomplete="off">
                        <button class="management-search-clear hidden" onclick="clearUserManagementSearch('tab-categories')" type="button" aria-label="Clear search">x</button>
                    </div>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${cats.map(c => `
                                <tr class="user-management-row" data-search="${userManagementSearchText([c.category_name, c.description, c.is_active ? 'active' : 'inactive'])}">
                                    <td><strong>${escHtml(c.category_name)}</strong></td>
                                    <td style="color:var(--text-muted);font-size:13px;">${c.description || '—'}</td>
                                    <td><span class="badge ${c.is_active ? 'badge-resolved' : 'badge-closed'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
                                    <td><button class="btn btn-secondary btn-sm" onclick='openCategoryModal(${JSON.stringify(c).replace(/'/g,"&#39;")})'>Edit</button></td>
                                </tr>
                            `).join('')}
                            <tr class="user-management-empty-row hidden"><td colspan="4"><div class="table-empty-state">No categories match your search.</div></td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <div id="tab-departments" class="hidden">
            <div class="card">
                <div class="card-header management-toolbar">
                    <button class="btn btn-primary btn-sm" onclick="openDepartmentModal()">New Department</button>
                    <div class="search-input-wrap management-search-input">
                        <span class="search-icon">⌕</span>
                        <input data-management-search type="search" placeholder="Search departments..." oninput="filterUserManagementTab('tab-departments')" autocomplete="off">
                        <button class="management-search-clear hidden" onclick="clearUserManagementSearch('tab-departments')" type="button" aria-label="Clear search">x</button>
                    </div>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${depts.map(d => `
                                <tr class="user-management-row" data-search="${userManagementSearchText([d.department_name, d.description, d.head, d.manager, d.head_name, d.manager_name, d.is_active ? 'active' : 'inactive'])}">
                                    <td><strong>${escHtml(d.department_name)}</strong></td>
                                    <td style="color:var(--text-muted);font-size:13px;">${d.description || '—'}</td>
                                    <td><span class="badge ${d.is_active ? 'badge-resolved' : 'badge-closed'}">${d.is_active ? 'Active' : 'Inactive'}</span></td>
                                    <td><button class="btn btn-secondary btn-sm" onclick='openDepartmentModal(${JSON.stringify(d).replace(/'/g,"&#39;")})'>Edit</button></td>
                                </tr>
                            `).join('')}
                            <tr class="user-management-empty-row hidden"><td colspan="4"><div class="table-empty-state">No departments match your search.</div></td></tr>
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

function formatDuration(minutes) {
    if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '-';
    const totalMinutes = Math.max(0, Math.round(Number(minutes)));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${mins}m`;
    return `${mins}m`;
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

function slaStatusBadge(status) {
    const map = { 'On Time': 'resolved', Warning: 'pending', Overdue: 'urgent' };
    return `<span class="badge badge-${map[status] || 'normal'}">${escHtml(status || 'On Time')}</span>`;
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
        closeMobileSidebar();
    }
});

// CSS animation
const style = document.createElement('style');
style.textContent = `@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
document.head.appendChild(style);

// --- ASSET MANAGEMENT MODULE ---
let currentAssetId = null;
let currentAssetFilters = {};
let selectedAssetFiles = [];

const ASSET_STATUSES = ['Available', 'Assigned', 'For Inspection', 'Under Repair', 'Returned', 'Pulled Out', 'Retired', 'Lost'];

function canManageAssets() {
    return ['Super Admin', 'Admin', 'Staff'].includes(currentUser?.role_name);
}

const coreSetupNav = setupNav;
setupNav = function() {
    coreSetupNav();
    const nav = document.getElementById('sidebar-nav');
    if (!nav || nav.querySelector('[data-page="assets"]')) return;

    const usersNav = nav.querySelector('[data-page="users"]');
    const item = document.createElement('div');
    item.className = 'nav-item';
    item.dataset.page = 'assets';
    item.dataset.tip = 'Assets';
    item.onclick = () => navigateTo('assets');
    item.innerHTML = `
        <span class="nav-icon">A</span>
        <span class="nav-text">Assets</span>
    `;

    if (usersNav) nav.insertBefore(item, usersNav);
    else nav.appendChild(item);
};

const coreNavigateTo = navigateTo;
navigateTo = function(page) {
    closeMobileSidebar();
    if (!['assets', 'add-asset', 'edit-asset', 'asset-details'].includes(page)) {
        coreNavigateTo(page);
        return;
    }

    localStorage.setItem('current-page', page);
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === 'assets');
    });

    const titles = {
        assets: 'Asset Management',
        'add-asset': 'Add Asset',
        'edit-asset': 'Edit Asset',
        'asset-details': 'Asset Details'
    };
    document.getElementById('page-title').textContent = titles[page] || 'Asset Management';
    document.getElementById('page-content').innerHTML = '<div class="empty-state"><div class="empty-icon">...</div><p>Loading...</p></div>';

    if (page === 'assets') assetsPage();
    if (page === 'add-asset') addAssetPage();
    if (page === 'edit-asset') editAssetPage(currentAssetId);
    if (page === 'asset-details') assetDetailsPage(currentAssetId);
};

async function safeJson(endpoint, fallback = {}) {
    try {
        const res = await fetch(`/api${endpoint}`, { credentials: 'include' });
        const type = res.headers.get('content-type') || '';
        if (!type.includes('application/json')) return fallback;
        const data = await res.json();
        return data.success === false ? fallback : data;
    } catch (err) {
        return fallback;
    }
}

async function assetRequest(method, endpoint, body = null, isFormData = false) {
    try {
        const opts = {
            method,
            credentials: 'include',
            headers: isFormData ? {} : { 'Content-Type': 'application/json' }
        };
        if (body) opts.body = isFormData ? body : JSON.stringify(body);
        const res = await fetch(`/api/assets${endpoint}`, opts);
        const type = res.headers.get('content-type') || '';
        if (!type.includes('application/json')) {
            return { success: false, message: 'Asset API is not available yet.' };
        }
        return await res.json();
    } catch (err) {
        return { success: false, message: 'Unable to connect to Asset API.' };
    }
}

async function getAssetMeta() {
    const [catData, deptData, userData] = await Promise.all([
        assetRequest('GET', '/categories'),
        safeJson('/users/departments', { departments: [] }),
        canManageAssets() ? assetRequest('GET', '/assignable-users') : Promise.resolve({ users: [] })
    ]);

    return {
        categories: catData.categories || catData.asset_categories || [],
        departments: deptData.departments || [],
        users: userData.users || []
    };
}

async function assetsPage(filters = currentAssetFilters) {
    currentAssetFilters = filters || {};
    const params = new URLSearchParams();
    if (currentAssetFilters.search) params.set('search', currentAssetFilters.search);
    if (currentAssetFilters.status) params.set('status', currentAssetFilters.status);
    if (currentAssetFilters.category_id) params.set('category_id', currentAssetFilters.category_id);
    if (currentAssetFilters.department) params.set('department', currentAssetFilters.department);
    if (currentAssetFilters.assigned_to) params.set('assigned_to', currentAssetFilters.assigned_to);

    const [assetsData, meta] = await Promise.all([
        assetRequest('GET', `/?${params.toString()}`),
        getAssetMeta()
    ]);

    const assets = assetsData.assets || assetsData.data || [];
    const returnedAssets = assetsData.returned_assets || assetsData.asset_history || [];
    const stats = getAssetStats(assets);
    const pageEl = document.getElementById('page-content');

    if (!canManageAssets()) {
        pageEl.innerHTML = `
            <div id="asset-alert">${assetsData.success === false ? `<div class="alert alert-warning">${escHtml(assetsData.message || 'Asset API is not available yet.')}</div>` : ''}</div>

            <div class="card" style="margin-bottom:20px;">
                <div class="card-header">
                    <span class="card-title">Current Assigned Assets</span>
                </div>
                <div class="table-wrapper">
                    ${assets.length ? renderAssetTable(assets, { userView: true }) : '<div class="empty-state"><div class="empty-icon">A</div><h3>No current assigned assets</h3></div>'}
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-title">Returned / Pulled Out Asset History</span>
                </div>
                <div class="table-wrapper">
                    ${returnedAssets.length ? renderReturnedAssetTable(returnedAssets) : '<div class="empty-state"><div class="empty-icon">A</div><h3>No returned assets yet</h3></div>'}
                </div>
            </div>
        `;
        return;
    }

    pageEl.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon">A</div>
                <div class="stat-label">Total Assets</div>
                <div class="stat-value">${stats.total}</div>
            </div>
            <div class="stat-card success">
                <div class="stat-icon">OK</div>
                <div class="stat-label">Available</div>
                <div class="stat-value">${stats.available}</div>
            </div>
            <div class="stat-card accent">
                <div class="stat-icon">IN</div>
                <div class="stat-label">Assigned</div>
                <div class="stat-value">${stats.assigned}</div>
            </div>
            <div class="stat-card warning">
                <div class="stat-icon">RP</div>
                <div class="stat-label">Under Repair</div>
                <div class="stat-value">${stats.repair}</div>
            </div>
            <div class="stat-card danger">
                <div class="stat-icon">!</div>
                <div class="stat-label">Inactive / History</div>
                <div class="stat-value">${stats.inactive}</div>
            </div>
        </div>

        <div class="filters-bar">
            ${mobileFilterToggleMarkup('Filters')}
            <div class="mobile-filter-panel" onclick="event.stopPropagation()">
                <div class="search-input-wrap">
                    <span class="search-icon">S</span>
                    <input type="text" placeholder="Search assets..." id="asset-search" value="${escHtml(currentAssetFilters.search || '')}">
                </div>
                <select class="filter-select" id="asset-status" onchange="applyAssetFilters()">
                    <option value="">All Status</option>
                    ${ASSET_STATUSES.map(s => `<option value="${s}" ${currentAssetFilters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <select class="filter-select" id="asset-category" onchange="applyAssetFilters()">
                    <option value="">All Categories</option>
                    ${meta.categories.map(c => `<option value="${c.category_id}" ${String(currentAssetFilters.category_id || '') === String(c.category_id) ? 'selected' : ''}>${escHtml(c.category_name)}</option>`).join('')}
                </select>
                <select class="filter-select" id="asset-department" onchange="applyAssetFilters()">
                    <option value="">All Departments</option>
                    ${meta.departments.map(d => `<option value="${escHtml(d.department_name)}" ${currentAssetFilters.department === d.department_name ? 'selected' : ''}>${escHtml(d.department_name)}</option>`).join('')}
                </select>
                <select class="filter-select" id="asset-assigned" onchange="applyAssetFilters()">
                    <option value="">All Users</option>
                    <option value="unassigned" ${currentAssetFilters.assigned_to === 'unassigned' ? 'selected' : ''}>Unassigned</option>
                    ${meta.users.map(u => `<option value="${u.user_id}" ${String(currentAssetFilters.assigned_to || '') === String(u.user_id) ? 'selected' : ''}>${escHtml(u.full_name)}</option>`).join('')}
                </select>
                ${canManageAssets() ? `<button class="btn btn-secondary btn-sm" onclick="openAllAssetActivityLogs()">Activity Logs</button>` : ''}
                ${canManageAssets() ? `<button class="btn btn-primary btn-sm" onclick="navigateTo('add-asset')">Add Asset</button>` : ''}
            </div>
        </div>

        <div id="asset-alert">${assetsData.success === false ? `<div class="alert alert-warning">${escHtml(assetsData.message || 'Asset API is not available yet.')}</div>` : ''}</div>
        <div class="card">
            <div class="table-wrapper">
                ${assets.length ? renderAssetTable(assets) : '<div class="empty-state"><div class="empty-icon">A</div><h3>No assets found</h3><p>Try adjusting your filters.</p></div>'}
            </div>
        </div>
    `;

    let searchTimer;
    document.getElementById('asset-search')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyAssetFilters(), 400);
    });
}

function getAssetStats(assets) {
    return {
        total: assets.length,
        available: assets.filter(a => a.status === 'Available').length,
        assigned: assets.filter(a => a.status === 'Assigned').length,
        repair: assets.filter(a => ['For Inspection', 'Under Repair'].includes(a.status)).length,
        inactive: assets.filter(a => ['Returned', 'For Inspection', 'Pulled Out', 'Retired', 'Lost'].includes(a.status)).length
    };
}

function assetNeedsInspectionWarning(asset) {
    return Number(asset.returned_inspection_warning || asset.returnedInspectionWarning || 0) === 1;
}

function assetStatusCell(asset) {
    return `${assetStatusBadge(asset.status)}${assetNeedsInspectionWarning(asset) ? '<div style="margin-top:4px;"><span class="badge badge-pending">7+ days pending inspection</span></div>' : ''}`;
}

function applyAssetFilters() {
    assetsPage({
        search: document.getElementById('asset-search')?.value.trim(),
        status: document.getElementById('asset-status')?.value,
        category_id: document.getElementById('asset-category')?.value,
        department: document.getElementById('asset-department')?.value,
        assigned_to: document.getElementById('asset-assigned')?.value
    });
}

function renderAssetTable(assets, opts = {}) {
    return `
        <table>
            <thead>
                <tr>
                    <th>Asset Tag</th>
                    <th>Asset</th>
                    <th>Category</th>
                    <th>Status</th>
                    ${opts.userView ? '' : '<th>Assigned To</th>'}
                    <th>Department</th>
                    <th>Location</th>
                    <th>Warranty</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${assets.map(a => `
                    <tr>
                        <td><span class="ticket-number">${escHtml(a.asset_tag)}</span></td>
                        <td onclick="openAssetDetails(${a.asset_id})" style="cursor:pointer;">
                            <span class="ticket-link">${escHtml(a.asset_name)}</span>
                            <div style="color:var(--text-muted);font-size:12px;">${escHtml([a.brand, a.model].filter(Boolean).join(' ') || a.serial_number || '')}</div>
                        </td>
                        <td>${escHtml(a.category_name || a.category || '-')}</td>
                        <td>${assetStatusCell(a)}</td>
                        ${opts.userView ? '' : `<td>${escHtml(a.assigned_to_name || a.assigned_user_name || '-')}</td>`}
                        <td>${escHtml(a.department || '-')}</td>
                        <td>${escHtml(a.location || '-')}</td>
                        <td style="color:var(--text-muted);font-size:12px;">${formatDateOnly(a.warranty_expiry)}</td>
                        <td>
                            <div style="display:flex;gap:4px;flex-wrap:wrap;">
                                <button class="btn btn-secondary btn-sm" onclick="openAssetDetails(${a.asset_id})">View</button>
                                ${canManageAssets() ? `<button class="btn btn-secondary btn-sm" onclick="openEditAsset(${a.asset_id})">Edit</button>` : ''}
                                ${canManageAssets() && ['Returned', 'For Inspection', 'Under Repair'].includes(a.status) ? `<button class="btn btn-sm" style="background:var(--success-light);color:var(--success);" onclick="markAssetAvailable(${a.asset_id})">Mark Available</button>` : ''}
                                ${canManageAssets() ? `<button class="btn btn-sm" style="background:var(--danger-light);color:var(--danger);" onclick="deleteAsset(${a.asset_id})">Retire</button>` : ''}
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function renderReturnedAssetTable(assets) {
    return `
        <table>
            <thead>
                <tr>
                    <th>Asset Tag</th>
                    <th>Asset</th>
                    <th>Status</th>
                    <th>Returned</th>
                    <th>Related Ticket</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${assets.map(a => `
                    <tr>
                        <td><span class="ticket-number">${escHtml(a.asset_tag)}</span></td>
                        <td onclick="openAssetDetails(${a.asset_id})" style="cursor:pointer;">
                            <span class="ticket-link">${escHtml(a.asset_name)}</span>
                            <div style="color:var(--text-muted);font-size:12px;">${escHtml([a.brand, a.model].filter(Boolean).join(' ') || a.serial_number || '')}</div>
                        </td>
                        <td>${assetStatusBadge(a.return_status || a.status || 'Returned')}</td>
                        <td style="color:var(--text-muted);font-size:12px;">${formatDate(a.returned_at)}</td>
                        <td>
                            ${a.related_ticket_id ? `<span class="ticket-link" onclick="openTicket(${a.related_ticket_id})">${escHtml(a.related_ticket_number || 'View Ticket')}</span>` : '<span style="color:var(--text-muted);">-</span>'}
                        </td>
                        <td><button class="btn btn-secondary btn-sm" onclick="openAssetDetails(${a.asset_id})">View</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

async function addAssetPage() {
    if (!canManageAssets()) {
        document.getElementById('page-content').innerHTML = '<div class="alert alert-error">Insufficient permissions.</div>';
        return;
    }
    const meta = await getAssetMeta();
    renderAssetForm({}, meta, false);
}

async function editAssetPage(assetId) {
    if (!assetId) return navigateTo('assets');
    if (!canManageAssets()) {
        document.getElementById('page-content').innerHTML = '<div class="alert alert-error">Insufficient permissions.</div>';
        return;
    }
    const [assetData, meta] = await Promise.all([
        assetRequest('GET', `/${assetId}`),
        getAssetMeta()
    ]);
    const asset = assetData.asset || {};
    renderAssetForm(asset, meta, true);
}

function renderAssetForm(asset, meta, isEdit) {
    selectedAssetFiles = [];
    document.getElementById('page-content').innerHTML = `
        <div style="max-width:820px;">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">${isEdit ? 'Edit Asset' : 'Add Asset'}</span>
                </div>
                <div class="card-body">
                    <div id="asset-form-alert"></div>
                    <form id="asset-form">
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Asset Tag <span class="required">*</span></label>
                                <input class="form-input" id="asset-tag" value="${escHtml(asset.asset_tag || '')}" placeholder="AST-2026-0001" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Asset Name <span class="required">*</span></label>
                                <input class="form-input" id="asset-name" value="${escHtml(asset.asset_name || '')}" placeholder="Dell Latitude 5450" required>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Category</label>
                                <select class="form-select" id="asset-category-id">
                                    <option value="">Select category...</option>
                                    ${meta.categories.map(c => `<option value="${c.category_id}" ${String(asset.category_id || '') === String(c.category_id) ? 'selected' : ''}>${escHtml(c.category_name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Status</label>
                                <select class="form-select" id="asset-form-status" onchange="syncAssetAssignmentFields()">
                                    ${ASSET_STATUSES.map(s => `<option value="${s}" ${(asset.status || 'Available') === s ? 'selected' : ''}>${s}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Brand</label>
                                <input class="form-input" id="asset-brand" value="${escHtml(asset.brand || '')}" placeholder="Dell">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Model</label>
                                <input class="form-input" id="asset-model" value="${escHtml(asset.model || '')}" placeholder="Latitude 5450">
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Serial Number</label>
                                <input class="form-input" id="asset-serial" value="${escHtml(asset.serial_number || '')}" placeholder="Serial number">
                            </div>
                            <div class="form-group" id="asset-assigned-group">
                                <label class="form-label">Assigned User</label>
                                <select class="form-select" id="asset-assigned-to" onchange="applyAssignedUserMeta()">
                                    <option value="">Unassigned</option>
                                    ${meta.users.map(u => `<option value="${u.user_id}" data-department="${escHtml(u.department || '')}" data-role="${escHtml(u.role_name || '')}" data-location="${escHtml(u.branch || '')}" ${String(asset.assigned_to || '') === String(u.user_id) ? 'selected' : ''}>${escHtml(u.full_name)}${u.department ? ' - ' + escHtml(u.department) : ''}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group" id="asset-department-group">
                                <label class="form-label">Department</label>
                                <select class="form-select" id="asset-form-department">
                                    <option value="">Select department...</option>
                                    ${meta.departments.map(d => `<option value="${escHtml(d.department_name)}" ${asset.department === d.department_name ? 'selected' : ''}>${escHtml(d.department_name)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Location</label>
                                <input class="form-input" id="asset-location" value="${escHtml(asset.location || '')}" placeholder="HQ - 3rd Floor">
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group" id="asset-role-group">
                                <label class="form-label">Role</label>
                                <input class="form-input" id="asset-user-role" value="" disabled style="opacity:0.75;">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Upload Files</label>
                                <div class="upload-area" id="asset-upload-area" onclick="document.getElementById('asset-file-input').click()" ondragover="handleAssetDragOver(event)" ondrop="handleAssetDrop(event)" style="padding:16px;">
                                    <div class="upload-icon">File</div>
                                    <p>Click to upload or <strong>drag and drop</strong></p>
                                    <p style="font-size:11px;color:var(--text-muted);margin-top:4px;">Max 10MB per file. JPG, PNG, PDF, DOC, XLS, ZIP</p>
                                </div>
                                <input type="file" id="asset-file-input" multiple accept=".jpg,.jpeg,.png,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip" class="hidden" onchange="handleAssetFileSelect(event)">
                            </div>
                        </div>
                        <div class="file-list" id="asset-file-list" style="margin-bottom:16px;"></div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">Purchase Date</label>
                                <input type="date" class="form-input" id="asset-purchase-date" value="${dateInputValue(asset.purchase_date)}">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Warranty Expiry</label>
                                <input type="date" class="form-input" id="asset-warranty-expiry" value="${dateInputValue(asset.warranty_expiry)}">
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Supplier</label>
                            <input class="form-input" id="asset-supplier" value="${escHtml(asset.supplier || '')}" placeholder="Supplier or vendor">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Notes</label>
                            <textarea class="form-textarea" id="asset-notes" rows="4" placeholder="Additional details...">${escHtml(asset.notes || '')}</textarea>
                        </div>
                        <div style="display:flex;gap:10px;">
                            <button type="submit" class="btn btn-primary" id="asset-save-btn">${isEdit ? 'Save Changes' : 'Create Asset'}</button>
                            <button type="button" class="btn btn-secondary" onclick="${isEdit ? `openAssetDetails(${asset.asset_id})` : `navigateTo('assets')`}">Cancel</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    `;
    document.getElementById('asset-form').addEventListener('submit', e => submitAssetForm(e, asset.asset_id));
    syncAssetAssignmentFields();
}

function assetStatusAllowsAssignment(status) {
    return status === 'Assigned' || status === 'Under Repair';
}

function syncAssetAssignmentFields() {
    const status = document.getElementById('asset-form-status')?.value || 'Available';
    const allowAssignment = assetStatusAllowsAssignment(status);
    const assignedGroup = document.getElementById('asset-assigned-group');
    const departmentGroup = document.getElementById('asset-department-group');
    const roleGroup = document.getElementById('asset-role-group');
    const assignedEl = document.getElementById('asset-assigned-to');
    const departmentEl = document.getElementById('asset-form-department');
    const roleEl = document.getElementById('asset-user-role');

    [assignedGroup, departmentGroup, roleGroup].forEach(el => el?.classList.toggle('hidden', !allowAssignment));
    if (!allowAssignment) {
        if (assignedEl) assignedEl.value = '';
        if (departmentEl) departmentEl.value = '';
        if (roleEl) roleEl.value = '';
        return;
    }
    applyAssignedUserMeta();
}

function applyAssignedUserMeta() {
    const selected = document.getElementById('asset-assigned-to')?.selectedOptions?.[0];
    if (!selected || !selected.value) {
        const roleEl = document.getElementById('asset-user-role');
        if (roleEl) roleEl.value = '';
        return;
    }

    const department = selected.dataset.department || '';
    const role = selected.dataset.role || '';
    const location = selected.dataset.location || '';
    const departmentEl = document.getElementById('asset-form-department');
    const roleEl = document.getElementById('asset-user-role');
    const locationEl = document.getElementById('asset-location');

    if (departmentEl && department) departmentEl.value = department;
    if (roleEl) roleEl.value = role;
    if (locationEl && location) locationEl.value = location;
}

function handleAssetFileSelect(e) {
    const newFiles = Array.from(e.target.files);
    selectedAssetFiles = [...selectedAssetFiles, ...newFiles].slice(0, 5);
    renderAssetFileList();
}

function handleAssetDragOver(e) {
    e.preventDefault();
    document.getElementById('asset-upload-area')?.classList.add('drag-over');
}

function handleAssetDrop(e) {
    e.preventDefault();
    document.getElementById('asset-upload-area')?.classList.remove('drag-over');
    const newFiles = Array.from(e.dataTransfer.files);
    selectedAssetFiles = [...selectedAssetFiles, ...newFiles].slice(0, 5);
    renderAssetFileList();
}

function removeAssetFile(idx) {
    selectedAssetFiles.splice(idx, 1);
    renderAssetFileList();
}

function renderAssetFileList() {
    const list = document.getElementById('asset-file-list');
    if (!list) return;
    list.innerHTML = selectedAssetFiles.map((f, i) => `
        <div class="file-item">
            <span class="file-icon">${fileIcon(f.type)}</span>
            <span class="file-name">${escHtml(f.name)}</span>
            <span class="file-size">${formatFileSize(f.size)}</span>
            <span class="file-remove" onclick="removeAssetFile(${i})">x</span>
        </div>
    `).join('');
}

async function submitAssetForm(e, assetId = null) {
    e.preventDefault();
    const btn = document.getElementById('asset-save-btn');
    const alertEl = document.getElementById('asset-form-alert');
    const body = {
        asset_tag: document.getElementById('asset-tag').value.trim(),
        asset_name: document.getElementById('asset-name').value.trim(),
        category_id: document.getElementById('asset-category-id').value || null,
        brand: document.getElementById('asset-brand').value.trim(),
        model: document.getElementById('asset-model').value.trim(),
        serial_number: document.getElementById('asset-serial').value.trim(),
        status: document.getElementById('asset-form-status').value,
        assigned_to: assetStatusAllowsAssignment(document.getElementById('asset-form-status').value) ? (document.getElementById('asset-assigned-to').value || null) : null,
        department: assetStatusAllowsAssignment(document.getElementById('asset-form-status').value) ? document.getElementById('asset-form-department').value : '',
        location: document.getElementById('asset-location').value.trim(),
        purchase_date: document.getElementById('asset-purchase-date').value || null,
        warranty_expiry: document.getElementById('asset-warranty-expiry').value || null,
        supplier: document.getElementById('asset-supplier').value.trim(),
        notes: document.getElementById('asset-notes').value.trim()
    };

    if (!body.asset_tag || !body.asset_name) {
        alertEl.innerHTML = '<div class="alert alert-error">Asset tag and asset name are required.</div>';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving...';
    let data;
    if (selectedAssetFiles.length) {
        const fd = new FormData();
        Object.entries(body).forEach(([key, value]) => fd.append(key, value ?? ''));
        selectedAssetFiles.forEach(file => fd.append('attachments', file));
        data = assetId
            ? await assetRequest('PATCH', `/${assetId}`, fd, true)
            : await assetRequest('POST', '/', fd, true);
    } else {
        data = assetId
            ? await assetRequest('PATCH', `/${assetId}`, body)
            : await assetRequest('POST', '/', body);
    }

    if (data.success) {
        selectedAssetFiles = [];
        showToast(assetId ? 'Asset updated!' : 'Asset created!', 'success');
        const id = assetId || data.asset_id || data.asset?.asset_id;
        if (id) openAssetDetails(id);
        else navigateTo('assets');
    } else {
        alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to save asset.')}</div>`;
    }
    btn.disabled = false;
    btn.textContent = assetId ? 'Save Changes' : 'Create Asset';
}

function openAssetDetails(assetId) {
    currentAssetId = assetId;
    navigateTo('asset-details');
}

function openEditAsset(assetId) {
    currentAssetId = assetId;
    navigateTo('edit-asset');
}

async function deleteAsset(assetId) {
    if (!canManageAssets()) return showToast('Insufficient permissions.', 'error');
    if (!confirm('Retire this asset? It will be removed from active assignment.')) return;

    const data = await assetRequest('DELETE', `/${assetId}`);
    if (data.success) {
        showToast('Asset retired.', 'success');
        assetsPage();
    } else {
        showToast(data.message || 'Unable to retire asset.', 'error');
    }
}

async function markAssetAvailable(assetId) {
    if (!canManageAssets()) return showToast('Insufficient permissions.', 'error');
    if (!confirm('Mark this returned asset as Available?')) return;

    const data = await assetRequest('PATCH', `/${assetId}/mark-available`);
    if (data.success) {
        showToast('Asset marked as available.', 'success');
        if (currentPage === 'asset-details') openAssetDetails(assetId);
        else assetsPage();
    } else {
        showToast(data.message || 'Unable to mark asset as available.', 'error');
    }
}

async function assetDetailsPage(assetId) {
    if (!assetId) return navigateTo('assets');
    const data = await assetRequest('GET', `/${assetId}`);
    if (!data.success && !data.asset) {
        document.getElementById('page-content').innerHTML = `
            <div class="alert alert-error">${escHtml(data.message || 'Asset not found.')}</div>
            <button class="btn btn-secondary" onclick="navigateTo('assets')">Back to Assets</button>
        `;
        return;
    }

    const asset = data.asset || data;
    const assignments = data.assignments || data.assignment_history || [];
    const maintenance = data.maintenance_logs || data.maintenance || [];
    const tickets = data.tickets || [];
    const activity = data.asset_history || data.activity_logs || [];
    const attachments = data.attachments || [];
    const isCurrentUserAsset = data.is_currently_assigned_to_user !== false && asset.assigned_to === currentUser.user_id && asset.status === 'Assigned';
    const returnedContext = getReturnedAssetContext(asset, assignments, tickets);
    document.getElementById('page-content').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" onclick="navigateTo('assets')">Back</button>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${canManageAssets() ? `<button class="btn btn-secondary btn-sm" onclick="openMaintenanceModal(${asset.asset_id})">Add Maintenance</button>` : ''}
                ${canManageAssets() && ['Returned', 'For Inspection', 'Under Repair'].includes(asset.status) ? `<button class="btn btn-sm" style="background:var(--success-light);color:var(--success);" onclick="markAssetAvailable(${asset.asset_id})">Mark as Available</button>` : ''}
                ${canManageAssets() ? `<button class="btn btn-primary btn-sm" onclick="openEditAsset(${asset.asset_id})">Edit Asset</button>` : ''}
                ${canManageAssets() ? `<button class="btn btn-sm" style="background:var(--danger-light);color:var(--danger);" onclick="deleteAsset(${asset.asset_id})">Retire</button>` : ''}
            </div>
        </div>

        ${!canManageAssets() && !isCurrentUserAsset ? `
            <div class="alert alert-warning">
                This asset is no longer currently assigned to your account.
            </div>
        ` : ''}

        <div class="card" style="margin-bottom:20px;">
            <div class="card-header">
                <div>
                    <span class="ticket-number">${escHtml(asset.asset_tag)}</span>
                    <div class="card-title" style="margin-top:4px;">${escHtml(asset.asset_name)}</div>
                </div>
                <div>${assetStatusCell(asset)}</div>
            </div>
            <div class="card-body">
                <div class="ticket-detail-grid">
                    <div>
                        <div class="tabs">
                            <button class="tab-btn active" onclick="switchAssetDetailTab('asset-tab-details')">Details</button>
                            <button class="tab-btn" onclick="switchAssetDetailTab('asset-tab-tickets')">Tickets (${tickets.length})</button>
                            <button class="tab-btn" onclick="switchAssetDetailTab('asset-tab-assignments')">Assignments (${assignments.length})</button>
                            <button class="tab-btn" onclick="switchAssetDetailTab('asset-tab-maintenance')">Maintenance (${maintenance.length})</button>
                            <button class="tab-btn" onclick="switchAssetDetailTab('asset-tab-files')">Files (${attachments.length})</button>
                            <button class="tab-btn" onclick="switchAssetDetailTab('asset-tab-history')">History (${activity.length})</button>
                        </div>
                        <div id="asset-tab-details">
                            <p style="color:var(--text-secondary);font-size:13.5px;line-height:1.7;margin-bottom:20px;">${escHtml(asset.notes || 'No notes recorded for this asset.')}</p>
                            ${returnedContext ? renderReturnedAssetDetails(returnedContext) : ''}
                            <div class="form-row">
                                ${assetMetaBlock('Brand', asset.brand)}
                                ${assetMetaBlock('Model', asset.model)}
                                ${assetMetaBlock('Serial Number', asset.serial_number)}
                                ${assetMetaBlock('Supplier', asset.supplier)}
                                ${assetMetaBlock('Purchase Date', formatDateOnly(asset.purchase_date))}
                                ${assetMetaBlock('Warranty Expiry', formatDateOnly(asset.warranty_expiry))}
                            </div>
                        </div>
                        <div id="asset-tab-tickets" class="hidden">
                            ${renderAssetTicketHistory(tickets)}
                        </div>
                        <div id="asset-tab-assignments" class="hidden">
                            ${renderAssignmentHistory(assignments)}
                        </div>
                        <div id="asset-tab-maintenance" class="hidden">
                            ${renderMaintenanceLogs(maintenance)}
                        </div>
                        <div id="asset-tab-files" class="hidden">
                            ${renderAssetAttachments(attachments)}
                        </div>
                        <div id="asset-tab-history" class="hidden">${renderAssetHistoryTimeline(activity)}</div>
                    </div>
                    <div>
                        ${assetSideMeta('Category', asset.category_name || asset.category)}
                        ${assetSideMeta('Assigned To', asset.assigned_to_name || asset.assigned_user_name)}
                        ${assetSideMeta('Department', asset.department)}
                        ${assetSideMeta('Location', asset.location)}
                        ${assetSideMeta('Created', formatDate(asset.created_at))}
                        ${assetSideMeta('Updated', formatDate(asset.updated_at))}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function getReturnedAssetContext(asset, assignments, tickets) {
    const returnedAssignment = assignments.find(a => a.returned_at || ['Returned', 'For Inspection', 'Pulled Out'].includes(a.return_status));
    const relatedTicket = returnedAssignment?.related_ticket_id
        ? {
            ticket_id: returnedAssignment.related_ticket_id,
            ticket_number: returnedAssignment.related_ticket_number,
            title: returnedAssignment.related_ticket_title,
            category_name: returnedAssignment.related_ticket_category,
            status: returnedAssignment.related_ticket_status,
            created_at: returnedAssignment.related_ticket_created_at,
            resolved_at: returnedAssignment.related_ticket_resolved_at,
            resolution_notes: returnedAssignment.related_ticket_notes
        }
        : tickets[0];

    if (!returnedAssignment && !['Returned', 'For Inspection', 'Pulled Out', 'Retired', 'Lost'].includes(asset.status)) return null;
    return { assignment: returnedAssignment || {}, ticket: relatedTicket || null };
}

function renderReturnedAssetDetails(context) {
    const t = context.ticket;
    return `
        <div class="alert alert-warning" style="margin-bottom:16px;">
            Asset status: ${escHtml(context.assignment.return_status || 'Returned')}. This item is part of your asset history, not your current assigned assets.
        </div>
        <div style="border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:14px 0;margin-bottom:18px;">
            <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Related Ticket</div>
            ${t ? `
                <div class="ticket-detail-grid">
                    <div>
                        <div style="margin-bottom:10px;">
                            <span class="ticket-number">${escHtml(t.ticket_number || '-')}</span>
                            <div class="ticket-link" style="margin-top:4px;cursor:pointer;" onclick="openTicket(${t.ticket_id})">${escHtml(t.title || '-')}</div>
                        </div>
                        <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;">${escHtml(t.resolution_notes || context.assignment.return_notes || context.assignment.return_condition || 'No notes recorded.')}</p>
                    </div>
                    <div>
                        ${assetSideMeta('Category', t.category_name)}
                        ${assetSideMeta('Status', t.status)}
                        ${assetSideMeta('Created', formatDate(t.created_at))}
                        ${assetSideMeta('Resolved', formatDate(t.resolved_at))}
                    </div>
                </div>
            ` : '<div class="empty-state"><div class="empty-icon">A</div><h3>No related ticket recorded</h3></div>'}
        </div>
    `;
}

function switchAssetDetailTab(activeId) {
    ['asset-tab-details','asset-tab-tickets','asset-tab-assignments','asset-tab-maintenance','asset-tab-files','asset-tab-history'].forEach(id => {
        document.getElementById(id)?.classList.toggle('hidden', id !== activeId);
    });
    document.querySelectorAll('#page-content .tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes(activeId));
    });
}

function renderAssetAttachments(attachments) {
    if (!attachments.length) return '<div class="empty-state"><div class="empty-icon">A</div><h3>No files uploaded</h3></div>';
    return `
        <div style="display:flex;flex-direction:column;gap:8px;">
            ${attachments.map(a => `
                <div class="file-item">
                    <span class="file-icon">${fileIcon(a.file_type)}</span>
                    <span class="file-name">${escHtml(a.original_name || a.file_name)}</span>
                    <span class="file-size">${formatFileSize(a.file_size)}</span>
                    <a class="btn btn-secondary btn-sm" href="/api/assets/attachments/${a.attachment_id}/download" style="text-decoration:none;">Download</a>
                </div>
            `).join('')}
        </div>
    `;
}

function renderAssetTicketHistory(tickets) {
    if (!tickets.length) return '<div class="empty-state"><div class="empty-icon">A</div><h3>No linked tickets</h3></div>';
    return `
        <div class="table-wrapper">
            <table>
                <thead><tr><th>Ticket #</th><th>Title</th><th>Status</th><th>Priority</th><th>Created By</th><th>Created</th></tr></thead>
                <tbody>
                    ${tickets.map(t => `
                        <tr onclick="openTicket(${t.ticket_id})" style="cursor:pointer;">
                            <td><span class="ticket-number">${escHtml(t.ticket_number)}</span></td>
                            <td><span class="ticket-link">${escHtml(t.title)}</span></td>
                            <td>${statusBadge(t.status)}</td>
                            <td>${priorityBadge(t.priority)}</td>
                            <td>${escHtml(t.created_by_name || '-')}</td>
                            <td style="color:var(--text-muted);font-size:12px;">${formatDate(t.created_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function assetMetaBlock(label, value) {
    return `
        <div class="form-group">
            <label class="form-label">${label}</label>
            <div style="font-size:13.5px;color:var(--text-primary);">${escHtml(value || '-')}</div>
        </div>
    `;
}

function assetSideMeta(label, value) {
    return `
        <div class="ticket-meta-item">
            <div class="ticket-meta-label">${label}</div>
            <div class="ticket-meta-value">${escHtml(value || '-')}</div>
        </div>
    `;
}

function renderAssignmentHistory(assignments) {
    if (!assignments.length) return '<div class="empty-state"><div class="empty-icon">A</div><h3>No assignment history</h3></div>';
    return `
        <div class="table-wrapper">
            <table>
                <thead><tr><th>Assigned To</th><th>Department</th><th>Location</th><th>Assigned</th><th>Returned</th></tr></thead>
                <tbody>
                    ${assignments.map(a => `
                        <tr>
                            <td>${escHtml(a.assigned_to_name || a.full_name || '-')}</td>
                            <td>${escHtml(a.department || '-')}</td>
                            <td>${escHtml(a.location || '-')}</td>
                            <td style="color:var(--text-muted);font-size:12px;">${formatDate(a.assigned_at)}</td>
                            <td style="color:var(--text-muted);font-size:12px;">${formatDate(a.returned_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderMaintenanceLogs(logs) {
    if (!logs.length) return '<div class="empty-state"><div class="empty-icon">A</div><h3>No maintenance logs</h3></div>';
    return `
        <div class="table-wrapper">
            <table>
                <thead><tr><th>Type</th><th>Description</th><th>Status</th><th>Vendor</th><th>Date</th><th>Cost</th></tr></thead>
                <tbody>
                    ${logs.map(l => `
                        <tr>
                            <td>${escHtml(l.maintenance_type || '-')}</td>
                            <td>${escHtml(l.description || '-')}</td>
                            <td>${assetMaintenanceBadge(l.status)}</td>
                            <td>${escHtml(l.vendor || '-')}</td>
                            <td style="color:var(--text-muted);font-size:12px;">${formatDate(l.maintenance_date)}</td>
                            <td>${l.cost ? escHtml(Number(l.cost).toLocaleString('en-PH', { style: 'currency', currency: 'PHP' })) : '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderAssetActivityLogs(logs) {
    if (!logs.length) return '<div class="empty-state"><div class="empty-icon">A</div><h3>No activity logs</h3></div>';
    return `
        <div style="display:flex;flex-direction:column;gap:8px;">
            ${logs.map(l => `
                <div style="display:flex;gap:12px;align-items:flex-start;">
                    <div style="width:6px;height:6px;background:var(--accent);border-radius:50%;margin-top:6px;flex-shrink:0;"></div>
                    <div>
                        <div style="font-size:13px;"><strong>${escHtml(l.changed_by_name || 'System')}</strong> - ${escHtml(l.action)}</div>
                        ${l.related_ticket_number ? `<div style="font-size:12px;color:var(--text-secondary);">Ticket: ${escHtml(l.related_ticket_number)}</div>` : ''}
                        <div style="font-size:12px;color:var(--text-muted);">${escHtml(l.old_value || '-')} -> ${escHtml(l.new_value || '-')}</div>
                        <div style="font-size:11px;color:var(--text-muted);">${formatDate(l.created_at)}</div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function assetHistoryTone(action = '') {
    if (action.includes('created')) return 'success';
    if (action.includes('assigned')) return 'accent';
    if (action.includes('returned') || action.includes('return')) return 'warning';
    if (action.includes('pulled')) return 'danger';
    if (action.includes('updated') || action.includes('changed')) return 'neutral';
    return 'neutral';
}

function assetHistoryRemarks(item) {
    const parts = [];
    if (item.assigned_employee_name) parts.push(`Employee: ${item.assigned_employee_name}`);
    if (item.related_ticket_number) parts.push(`Ticket: ${item.related_ticket_number}`);

    const oldValue = item.old_value && item.old_value !== 'null' ? formatAssetHistoryValue(item.old_value) : '';
    const newValue = item.new_value && item.new_value !== 'null' ? formatAssetHistoryValue(item.new_value) : '';
    if (oldValue || newValue) {
        if (oldValue && newValue) parts.push(`${oldValue} -> ${newValue}`);
        else if (newValue) parts.push(newValue);
        else parts.push(oldValue);
    }

    return parts.length ? parts.join(' | ') : 'No remarks recorded.';
}

function formatAssetHistoryValue(value) {
    if (!value) return '';
    const text = String(value);
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const labels = {
                asset_tag: 'Asset tag',
                asset_name: 'Asset name',
                category_id: 'Category',
                brand: 'Brand',
                model: 'Model',
                serial_number: 'Serial number',
                status: 'Status',
                assigned_to: 'Assigned user',
                department: 'Department',
                location: 'Location',
                purchase_date: 'Purchase date',
                warranty_expiry: 'Warranty expiry',
                supplier: 'Supplier',
                notes: 'Notes'
            };
            return Object.entries(parsed)
                .filter(([key, val]) => labels[key] && val !== null && val !== undefined && val !== '')
                .map(([key, val]) => `${labels[key]}: ${val}`)
                .join(', ');
        }
    } catch (err) {}
    return text;
}

function renderAssetHistoryTimeline(history) {
    if (!history.length) {
        return '<div class="empty-state"><div class="empty-icon">A</div><h3>No asset history yet</h3><p>Asset events will appear here automatically.</p></div>';
    }

    return `
        <div class="asset-history-timeline">
            ${history.map(item => {
                const action = String(item.action || 'Asset activity');
                const tone = assetHistoryTone(action.toLowerCase());
                return `
                    <div class="asset-history-item ${tone}">
                        <div class="asset-history-marker"></div>
                        <div class="asset-history-card">
                            <div class="asset-history-head">
                                <div>
                                    <div class="asset-history-action">${escHtml(action)}</div>
                                    <div class="asset-history-meta">
                                        ${escHtml(item.changed_by_name || 'System')}
                                        ${item.changed_by_role_name ? ` (${escHtml(item.changed_by_role_name)})` : ''}
                                    </div>
                                </div>
                                <div class="asset-history-date">${formatDate(item.created_at)}</div>
                            </div>
                            <div class="asset-history-details">
                                ${item.assigned_employee_name ? `<span>Assigned employee: <strong>${escHtml(item.assigned_employee_name)}</strong></span>` : ''}
                                ${item.related_ticket_number ? `<span>Related ticket: <strong>${escHtml(item.related_ticket_number)}</strong></span>` : ''}
                                <span>Remarks: ${escHtml(assetHistoryRemarks(item))}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

async function openAllAssetActivityLogs() {
    if (!canManageAssets()) return showToast('Insufficient permissions.', 'error');
    const data = await assetRequest('GET', '/activity-logs');
    const logs = data.activity_logs || [];
    const html = `
        <div class="modal-overlay active" id="asset-activity-modal">
            <div class="modal modal-lg">
                <div class="modal-header">
                    <span class="modal-title">Asset Activity Logs</span>
                    <button class="modal-close" onclick="closeModal('asset-activity-modal')">x</button>
                </div>
                <div class="modal-body">
                    ${logs.length ? `
                    <div class="table-wrapper">
                        <table>
                            <thead><tr><th>Asset</th><th>Action</th><th>Changed By</th><th>Old</th><th>New</th><th>Date</th></tr></thead>
                            <tbody>
                                ${logs.map(l => `
                                    <tr>
                                        <td><span class="ticket-number">${escHtml(l.asset_tag)}</span><div>${escHtml(l.asset_name)}</div></td>
                                        <td>${escHtml(l.action)}</td>
                                        <td>${escHtml(l.changed_by_name || 'System')}</td>
                                        <td style="color:var(--text-muted);font-size:12px;">${escHtml(l.old_value || '-')}</td>
                                        <td style="color:var(--text-muted);font-size:12px;">${escHtml(l.new_value || '-')}</td>
                                        <td style="color:var(--text-muted);font-size:12px;">${formatDate(l.created_at)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>` : '<div class="empty-state"><div class="empty-icon">A</div><h3>No activity logs</h3></div>'}
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
}

function openMaintenanceModal(assetId) {
    if (!canManageAssets()) return showToast('Insufficient permissions.', 'error');
    const html = `
        <div class="modal-overlay active" id="maintenance-modal">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">Add Maintenance Log</span>
                    <button class="modal-close" onclick="closeModal('maintenance-modal')">x</button>
                </div>
                <div class="modal-body">
                    <div id="maintenance-alert"></div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Type</label>
                            <input class="form-input" id="ml-type" placeholder="Repair, cleaning, upgrade">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Status</label>
                            <select class="form-select" id="ml-status">
                                <option value="Completed">Completed</option>
                                <option value="Scheduled">Scheduled</option>
                                <option value="In Progress">In Progress</option>
                                <option value="Cancelled">Cancelled</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Description <span class="required">*</span></label>
                        <textarea class="form-textarea" id="ml-description" rows="4" placeholder="What was done?"></textarea>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Vendor</label>
                            <input class="form-input" id="ml-vendor" placeholder="Vendor or supplier">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Cost</label>
                            <input type="number" step="0.01" class="form-input" id="ml-cost" placeholder="0.00">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Notes</label>
                        <textarea class="form-textarea" id="ml-notes" rows="2" placeholder="Additional notes..."></textarea>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('maintenance-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitMaintenanceLog(${assetId})">Save Log</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
}

async function submitMaintenanceLog(assetId) {
    const alertEl = document.getElementById('maintenance-alert');
    const body = {
        maintenance_type: document.getElementById('ml-type').value.trim(),
        status: document.getElementById('ml-status').value,
        description: document.getElementById('ml-description').value.trim(),
        vendor: document.getElementById('ml-vendor').value.trim(),
        cost: document.getElementById('ml-cost').value || null,
        notes: document.getElementById('ml-notes').value.trim()
    };
    if (!body.description) {
        alertEl.innerHTML = '<div class="alert alert-error">Maintenance description required.</div>';
        return;
    }
    const data = await assetRequest('POST', `/${assetId}/maintenance`, body);
    if (data.success) {
        closeModal('maintenance-modal');
        showToast('Maintenance log added.', 'success');
        openAssetDetails(assetId);
    } else {
        alertEl.innerHTML = `<div class="alert alert-error">${escHtml(data.message || 'Unable to save maintenance log.')}</div>`;
    }
}

function assetStatusBadge(status) {
    const map = {
        Available: 'resolved',
        Assigned: 'normal',
        'For Inspection': 'pending',
        'Under Repair': 'pending',
        Returned: 'closed',
        'Pulled Out': 'urgent',
        Retired: 'closed',
        Lost: 'urgent'
    };
    return `<span class="badge badge-${map[status] || 'normal'}">${escHtml(status || 'Available')}</span>`;
}

function assetMaintenanceBadge(status) {
    const map = {
        Scheduled: 'normal',
        'In Progress': 'pending',
        Completed: 'resolved',
        Cancelled: 'closed'
    };
    return `<span class="badge badge-${map[status] || 'normal'}">${escHtml(status || 'Completed')}</span>`;
}

function dateInputValue(dateStr) {
    if (!dateStr) return '';
    return String(dateStr).slice(0, 10);
}

function formatDateOnly(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}
