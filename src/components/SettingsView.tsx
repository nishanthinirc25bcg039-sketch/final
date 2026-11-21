import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Lock,
  Shield,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../utils/api';
import { Modal } from './ui/Common';
import type { AppSettings, User, UserRole } from '../shared/types';

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
];

export function SettingsView({
  currentUser,
  settings,
  onDataChanged,
  onWorkspaceDeleted,
  onNotify,
}: {
  currentUser: User;
  settings: AppSettings;
  onDataChanged: () => Promise<void>;
  onWorkspaceDeleted: () => void;
  onNotify: (msg: string, tone?: 'success' | 'error') => void;
}) {
  const isAdmin = currentUser.role === 'admin';
  const [form, setForm] = useState<AppSettings>(settings);
  const [savingSettings, setSavingSettings] = useState(false);

  // Change Password (available to both Staff & Admin)
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  // Team & Role Access (Admin)
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUser, setNewUser] = useState({
    name: '',
    email: '',
    password: '',
    role: 'staff' as UserRole,
  });
  const [userError, setUserError] = useState<string | null>(null);
  const [savingUser, setSavingUser] = useState(false);

  // Issued One-Time Password Reset Token Modal
  const [issuedTokenInfo, setIssuedTokenInfo] = useState<{
    token: string;
    expiresAt: string;
    userName: string;
    userEmail: string;
  } | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  // Backup Export & Workspace Deletion
  const [exportingBackup, setExportingBackup] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const loadUsers = async () => {
    if (!isAdmin) return;
    setLoadingUsers(true);
    try {
      const res = await apiFetch<{ users: User[] }>('/api/users');
      setUsers(res.users);
    } catch {
      // ignore if non-admin
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [isAdmin]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.businessName.trim()) {
      onNotify('Business name cannot be empty.', 'error');
      return;
    }
    setSavingSettings(true);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      await onDataChanged();
      onNotify('Workspace preferences saved.');
    } catch (err) {
      // Unsaved inputs remain intact on error
      onNotify(err instanceof Error ? err.message : 'Unable to save preferences.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    if (!currentPassword) {
      setPasswordError('Enter your current password.');
      return;
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setPasswordError('New password must be at least 8 characters and include a letter and a number.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('New password confirmation does not match.');
      return;
    }

    setChangingPassword(true);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      onNotify('Password updated.');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Unable to update password.');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserError(null);
    if (!newUser.name.trim() || !newUser.email.trim()) {
      setUserError('Full name and a valid email address are required.');
      return;
    }
    if (
      newUser.password.length < 8 ||
      !/[A-Za-z]/.test(newUser.password) ||
      !/[0-9]/.test(newUser.password)
    ) {
      setUserError('Password must be at least 8 characters and include both a letter and a number.');
      return;
    }
    setSavingUser(true);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      setAddUserOpen(false);
      onNotify(`Created ${newUser.role} account for ${newUser.name}`);
      setNewUser({ name: '', email: '', password: '', role: 'staff' });
      await loadUsers();
    } catch (err) {
      setUserError(err instanceof Error ? err.message : 'Unable to create team user.');
    } finally {
      setSavingUser(false);
    }
  };

  const handleToggleActive = async (u: User) => {
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !u.active }),
      });
      await loadUsers();
      onNotify(`${u.name} ${u.active ? 'deactivated' : 'reactivated'}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to update user status.', 'error');
    }
  };

  const handleRoleChange = async (u: User, nextRole: UserRole) => {
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      await loadUsers();
      onNotify(`Updated ${u.name} role to ${nextRole}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to change user role.', 'error');
    }
  };

  const handleIssueResetToken = async (u: User) => {
    try {
      const res = await apiFetch<{
        token: string;
        expiresAt: string;
        userName: string;
        userEmail: string;
      }>(`/api/users/${u.id}/reset-token`, { method: 'POST' });
      setCopiedToken(false);
      setIssuedTokenInfo(res);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to issue reset token.', 'error');
    }
  };

  const handleExportBackup = async () => {
    setExportingBackup(true);
    try {
      const token = getAuthToken();
      const headers = new Headers({ 'X-Requested-With': 'SmartStockAI' });
      if (token) headers.set('Authorization', `Bearer ${token}`);

      const res = await fetch('/api/backup/export', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to export workspace backup.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smartstock-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onNotify('Full JSON backup downloaded.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to export backup.', 'error');
    } finally {
      setExportingBackup(false);
    }
  };

  const handleDeleteWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError(null);
    if (!deletePassword) {
      setDeleteError('Enter your current admin password to confirm deletion.');
      return;
    }
    setDeletingWorkspace(true);
    try {
      await apiFetch('/api/account/workspace', {
        method: 'DELETE',
        body: JSON.stringify({ password: deletePassword }),
      });
      setDeleteModalOpen(false);
      onWorkspaceDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unable to delete workspace.');
    } finally {
      setDeletingWorkspace(false);
    }
  };

  const timezoneOptions = COMMON_TIMEZONES.includes(form.timezone)
    ? COMMON_TIMEZONES
    : [form.timezone, ...COMMON_TIMEZONES];

  const changePasswordCard = (
    <form onSubmit={handleChangePassword} noValidate className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-teal-700" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-slate-900">Change Your Password</h2>
          <p className="text-xs text-slate-500">
            Update the password for {currentUser.name} ({currentUser.email}).
          </p>
        </div>
      </div>

      {passwordError && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          {passwordError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="pw-current" className="block text-xs font-medium text-slate-700 mb-1">
            Current Password
          </label>
          <input
            id="pw-current"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>
        <div>
          <label htmlFor="pw-new" className="block text-xs font-medium text-slate-700 mb-1">
            New Password
          </label>
          <input
            id="pw-new"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="8+ chars, letter & number"
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>
        <div>
          <label htmlFor="pw-confirm" className="block text-xs font-medium text-slate-700 mb-1">
            Confirm New Password
          </label>
          <input
            id="pw-confirm"
            type="password"
            value={confirmNewPassword}
            onChange={(e) => setConfirmNewPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={changingPassword}
          className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60"
        >
          {changingPassword ? 'Updating...' : 'Update Password'}
        </button>
      </div>
    </form>
  );

  if (!isAdmin) {
    return (
      <div className="max-w-3xl space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-slate-100 text-slate-600">
              <Lock className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Staff Account Access</h2>
              <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                You are signed in as <strong>{currentUser.name}</strong> ({currentUser.email}) with the{' '}
                <strong className="capitalize">{currentUser.role}</strong> role. Staff accounts can record stock-in/stock-out movements, view products and suppliers, and receive purchase orders. Workspace preferences, team access, and backups are restricted to Admins.
              </p>
            </div>
          </div>
        </div>

        {changePasswordCard}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Store & Notification Preferences */}
      <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Store & Notification Preferences</h2>
          <p className="text-xs text-slate-500">
            Applies across dashboard metrics, stock alerts, and valuation reports for this workspace.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="set-biz" className="block text-xs font-medium text-slate-700 mb-1">
              Business Name *
            </label>
            <input
              id="set-biz"
              value={form.businessName}
              onChange={(e) => setForm({ ...form, businessName: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="set-currency" className="block text-xs font-medium text-slate-700 mb-1">
              Currency Symbol
            </label>
            <input
              id="set-currency"
              maxLength={4}
              value={form.currencySymbol}
              onChange={(e) => setForm({ ...form, currencySymbol: e.target.value })}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="set-tz" className="block text-xs font-medium text-slate-700 mb-1">
              Timezone
            </label>
            <select
              id="set-tz"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            >
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="set-mult" className="block text-xs font-medium text-slate-700 mb-1">
              Reorder Multiplier
            </label>
            <input
              id="set-mult"
              type="number"
              min="1"
              max="5"
              step="0.5"
              value={form.defaultReorderMultiplier}
              onChange={(e) => setForm({ ...form, defaultReorderMultiplier: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 space-y-2.5">
          <div className="text-xs font-semibold text-slate-700">Notification Preferences</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.lowStockBannerEnabled}
                onChange={(e) => setForm({ ...form, lowStockBannerEnabled: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
              />
              <span>Low-stock header notifications</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.lowStockDigestEnabled}
                onChange={(e) => setForm({ ...form, lowStockDigestEnabled: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
              />
              <span>Daily low-stock digest summary</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.poStatusAlertsEnabled}
                onChange={(e) => setForm({ ...form, poStatusAlertsEnabled: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
              />
              <span>Purchase order delivery updates</span>
            </label>
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-slate-100">
          <button
            type="submit"
            disabled={savingSettings}
            className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
          >
            {savingSettings ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>
      </form>

      {/* Change Current User Password */}
      {changePasswordCard}

      {/* Team & Role Access */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Team & Role Access</h2>
            <p className="text-xs text-slate-500">
              Admins manage catalog, suppliers, users, backups, and adjustments. Staff record stock-in/out and PO receipts. Issue one-time reset tokens here if a teammate forgets their password.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setUserError(null);
              setAddUserOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap self-start sm:self-auto"
          >
            <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Add User</span>
          </button>
        </div>

        {loadingUsers ? (
          <p className="text-xs text-slate-500 py-4">Loading team accounts...</p>
        ) : (
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {users.map((u) => (
              <div key={u.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm">
                <div>
                  <div className="font-medium text-slate-900">
                    {u.name}{' '}
                    {u.id === currentUser.id && (
                      <span className="text-[11px] font-mono text-teal-700">(You)</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-xs font-medium ${u.active ? 'text-emerald-700' : 'text-slate-500'}`}>
                    {u.active ? 'Active' : 'Inactive'}
                  </span>

                  {u.id !== currentUser.id && (
                    <>
                      <select
                        aria-label={`Role for ${u.name}`}
                        value={u.role}
                        onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                        className="px-2 py-1 text-xs border border-slate-300 rounded-md bg-white"
                      >
                        <option value="staff">Staff</option>
                        <option value="admin">Admin</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => handleToggleActive(u)}
                        className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200"
                      >
                        {u.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => handleIssueResetToken(u)}
                    className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100"
                  >
                    Issue Reset Token
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backup Export & Workspace Danger Zone */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Shield className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <span>Workspace Backup Export</span>
            </div>
            <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
              Download a full JSON snapshot of this workspace&apos;s products, suppliers, immutable stock ledger, purchase orders, and alerts stored in the server SQLite database.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportBackup}
            disabled={exportingBackup}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{exportingBackup ? 'Exporting...' : 'Export JSON Backup'}</span>
          </button>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-red-800">Delete Workspace & Account Data</h3>
            <p className="text-xs text-slate-600 max-w-2xl">
              Permanently deletes this business workspace and all associated team accounts, products, suppliers, transactions, and purchase orders.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDeletePassword('');
              setDeleteError(null);
              setDeleteModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Delete Workspace</span>
          </button>
        </div>
      </div>

      {/* Add User Modal */}
      <Modal open={addUserOpen} onClose={() => setAddUserOpen(false)} title="Add Team Account" maxWidth="max-w-md">
        <form onSubmit={handleAddUser} noValidate className="space-y-3.5">
          {userError && (
            <div role="alert" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {userError}
            </div>
          )}
          <div>
            <label htmlFor="u-name" className="block text-xs font-medium text-slate-700 mb-1">Full Name *</label>
            <input
              id="u-name"
              value={newUser.name}
              onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="u-email" className="block text-xs font-medium text-slate-700 mb-1">Email *</label>
            <input
              id="u-email"
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="u-pass" className="block text-xs font-medium text-slate-700 mb-1">
              Initial Password (8+ chars, letter &amp; number) *
            </label>
            <input
              id="u-pass"
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="u-role" className="block text-xs font-medium text-slate-700 mb-1">Role</label>
            <select
              id="u-role"
              value={newUser.role}
              onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            >
              <option value="staff">Staff (Stock movements &amp; receiving)</option>
              <option value="admin">Admin (Full workspace management)</option>
            </select>
          </div>
          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddUserOpen(false)}
              className="px-4 py-2 text-sm text-slate-700 border border-slate-300 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingUser}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700"
            >
              {savingUser ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </Modal>

      {/* One-Time Reset Token Modal */}
      <Modal
        open={Boolean(issuedTokenInfo)}
        onClose={() => setIssuedTokenInfo(null)}
        title="One-Time Password Reset Token"
        subtitle={issuedTokenInfo ? `For ${issuedTokenInfo.userName} (${issuedTokenInfo.userEmail})` : undefined}
        maxWidth="max-w-md"
      >
        {issuedTokenInfo && (
          <div className="space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              Share this single-use token directly with your teammate. They can enter it on the{' '}
              <strong>Sign In → Reset Password → Complete Reset</strong> screen before{' '}
              <strong>{new Date(issuedTokenInfo.expiresAt).toLocaleTimeString()}</strong> (15 minutes).
            </p>
            <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <code className="flex-1 text-xs font-mono text-slate-900 break-all">
                {issuedTokenInfo.token}
              </code>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issuedTokenInfo.token);
                    setCopiedToken(true);
                  } catch {
                    // ignore clipboard fallback
                  }
                }}
                aria-label="Copy reset token"
                className="p-2 rounded-md text-slate-600 hover:bg-slate-200 shrink-0"
              >
                {copiedToken ? <Check className="w-4 h-4 text-emerald-700" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setIssuedTokenInfo(null)}
                className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Workspace Confirmation Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Confirm Permanent Workspace Deletion"
        subtitle="All products, suppliers, transactions, purchase orders, and users will be deleted."
        maxWidth="max-w-md"
      >
        <form onSubmit={handleDeleteWorkspace} noValidate className="space-y-4">
          {deleteError && (
            <div role="alert" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {deleteError}
            </div>
          )}
          <div>
            <label htmlFor="del-pw" className="block text-xs font-medium text-slate-700 mb-1">
              Enter your current Admin password to confirm *
            </label>
            <input
              id="del-pw"
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteModalOpen(false)}
              className="px-4 py-2 text-sm text-slate-700 border border-slate-300 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={deletingWorkspace}
              className="px-4 py-2 text-sm font-semibold text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-60"
            >
              {deletingWorkspace ? 'Deleting...' : 'Permanently Delete'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
