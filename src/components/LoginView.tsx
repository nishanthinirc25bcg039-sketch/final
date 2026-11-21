import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch, setAuthToken } from '../utils/api';
import type { User } from '../shared/types';

type AuthMode = 'signin' | 'signup' | 'reset';

export function LoginView({
  onLoginSuccess,
}: {
  onLoginSuccess: (user: User) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('signin');

  // Sign In state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Admin Sign Up state
  const [businessName, setBusinessName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [currencySymbol, setCurrencySymbol] = useState('$');
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  );

  // Reset Password state
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [ephemeralStorage, setEphemeralStorage] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ephemeralStorage?: boolean } | null) => {
        if (active && data?.ephemeralStorage) {
          setEphemeralStorage(true);
        }
      })
      .catch(() => {
        // ignore health probe error
      });
    return () => {
      active = false;
    };
  }, []);

  const clearFeedback = () => {
    setError(null);
    setResetNotice(null);
    setFieldErrors({});
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    const errs: Record<string, string> = {};
    const trimmed = email.trim();
    if (!trimmed) errs.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      errs.email = 'Enter a valid email address.';
    }
    if (!password) errs.password = 'Enter your password.';
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: trimmed, password, rememberMe }),
      });
      setAuthToken(data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    const errs: Record<string, string> = {};
    if (!businessName.trim()) errs.businessName = 'Business name is required.';
    if (!adminName.trim()) errs.name = 'Full name is required.';
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errs.email = 'Enter a valid email address.';
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      errs.password = 'Use at least 8 characters with both letters and numbers.';
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: User }>('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          businessName: businessName.trim(),
          name: adminName.trim(),
          email: trimmedEmail,
          password,
          currencySymbol: currencySymbol.trim() || '$',
          timezone: timezone.trim() || 'UTC',
          rememberMe,
        }),
      });
      setAuthToken(data.token);
      onLoginSuccess(data.user);
    } catch (err) {
      const eObj = err as Error & { fieldErrors?: Record<string, string> };
      setError(eObj.message || 'Unable to create business account.');
      if (eObj.fieldErrors) setFieldErrors(eObj.fieldErrors);
    } finally {
      setLoading(false);
    }
  };

  const handleRequestResetInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    if (!resetEmail.trim()) {
      setFieldErrors({ resetEmail: 'Enter your account email address.' });
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail.trim() }),
      });
      setResetNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to request password reset.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteReset = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    const errs: Record<string, string> = {};
    if (!resetToken.trim()) errs.resetToken = 'Enter the one-time reset token.';
    if (
      resetNewPassword.length < 8 ||
      !/[A-Za-z]/.test(resetNewPassword) ||
      !/[0-9]/.test(resetNewPassword)
    ) {
      errs.resetNewPassword = 'Use at least 8 characters with both letters and numbers.';
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setLoading(true);
    try {
      await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          token: resetToken.trim(),
          newPassword: resetNewPassword,
        }),
      });
      setResetToken('');
      setResetNewPassword('');
      setResetNotice('Password updated. You can now sign in with your new password.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-4 py-10">
      <div className="max-w-4xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left column: Operational Value & Security Model */}
        <div className="lg:col-span-5 bg-slate-900 text-white rounded-2xl p-7 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-teal-600 flex items-center justify-center shrink-0">
                <Layers className="w-5 h-5 text-white" aria-hidden="true" />
              </div>
              <span className="text-xl font-bold tracking-tight font-display">SmartStock AI</span>
            </div>

            <h1 className="mt-7 text-2xl sm:text-3xl font-semibold tracking-tight text-balance">
              Production inventory control for growing businesses.
            </h1>
            <p className="mt-3 text-sm text-slate-300 leading-relaxed">
              Manage your product catalog, supplier purchase orders, auditable stock movements, and Gemini-powered inventory insights inside an isolated business workspace.
            </p>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-800 space-y-3 text-xs text-slate-300">
            <div className="flex items-start gap-2.5">
              <Building2 className="w-4 h-4 text-teal-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <span className="font-semibold text-white block">Isolated Business Workspaces</span>
                Every workspace starts clean with zero sample records and isolates all inventory data per business account.
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-teal-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <span className="font-semibold text-white block">Verified Access & Audit Trail</span>
                Passwords are scrypt-hashed on the server and every stock receipt, outbound dispatch, and admin adjustment is immutably logged.
              </div>
            </div>
          </div>
        </div>

        {/* Right column: Sign In / Create Account / Password Reset */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-7 sm:p-8 flex flex-col justify-center">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-6" role="tablist">
            {(
              [
                { id: 'signin', label: 'Sign In' },
                { id: 'signup', label: 'Create Workspace' },
                { id: 'reset', label: 'Reset Password' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={mode === tab.id}
                onClick={() => {
                  setMode(tab.id);
                  clearFeedback();
                }}
                className={`flex-1 py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  mode === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {ephemeralStorage && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" aria-hidden="true" />
              <span>
                <strong>Serverless Temporary Storage:</strong> This Vercel preview stores SQLite data in ephemeral{' '}
                <code>/tmp</code>, which resets across cold starts and serverless instances. Accounts created here may not persist across sign-ins unless deployed on a persistent Node/Docker host or connected to an external database.
              </span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2.5 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {resetNotice && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2.5 p-3 rounded-lg bg-teal-50 border border-teal-200 text-sm text-teal-900"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-teal-700" aria-hidden="true" />
              <span>{resetNotice}</span>
            </div>
          )}

          {mode === 'signin' && (
            <>
              <h2 className="text-xl font-semibold text-slate-900">Sign in to your workspace</h2>
              <p className="mt-1 text-sm text-slate-500">
                Enter your registered work email and password.
              </p>

              <form onSubmit={handleSignIn} noValidate className="mt-5 space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Email address
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: '' }));
                    }}
                    placeholder="you@company.com"
                    className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  {fieldErrors.email && <p className="mt-1 text-xs text-red-600">{fieldErrors.email}</p>}
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: '' }));
                      }}
                      placeholder="Enter your password"
                      className="w-full px-3.5 py-2.5 pr-11 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-slate-800 rounded-md"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {fieldErrors.password && (
                    <p className="mt-1 text-xs text-red-600">{fieldErrors.password}</p>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
                    />
                    <span>Keep me signed in</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('reset');
                      clearFeedback();
                    }}
                    className="text-xs font-medium text-teal-700 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-60"
                >
                  {loading ? 'Signing in...' : 'Sign In'}
                </button>
              </form>
            </>
          )}

          {mode === 'signup' && (
            <>
              <h2 className="text-xl font-semibold text-slate-900">Create your business workspace</h2>
              <p className="mt-1 text-sm text-slate-500">
                Set up a clean inventory workspace with an administrator account.
              </p>

              <form onSubmit={handleSignUp} noValidate className="mt-5 space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label htmlFor="signup-biz" className="block text-xs font-medium text-slate-700 mb-1">
                      Business Name *
                    </label>
                    <input
                      id="signup-biz"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="e.g. Harbor Hardware LLC"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    {fieldErrors.businessName && (
                      <p className="mt-1 text-xs text-red-600">{fieldErrors.businessName}</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="signup-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Administrator Name *
                    </label>
                    <input
                      id="signup-name"
                      value={adminName}
                      onChange={(e) => setAdminName(e.target.value)}
                      placeholder="Your full name"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    {fieldErrors.name && <p className="mt-1 text-xs text-red-600">{fieldErrors.name}</p>}
                  </div>
                </div>

                <div>
                  <label htmlFor="signup-email" className="block text-xs font-medium text-slate-700 mb-1">
                    Work Email *
                  </label>
                  <input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@company.com"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  {fieldErrors.email && <p className="mt-1 text-xs text-red-600">{fieldErrors.email}</p>}
                </div>

                <div>
                  <label htmlFor="signup-password" className="block text-xs font-medium text-slate-700 mb-1">
                    Password * (min 8 chars, letters + numbers)
                  </label>
                  <div className="relative">
                    <input
                      id="signup-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Create a strong password"
                      className="w-full px-3 py-2 pr-11 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-slate-800 rounded-md"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {fieldErrors.password && (
                    <p className="mt-1 text-xs text-red-600">{fieldErrors.password}</p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label htmlFor="signup-currency" className="block text-xs font-medium text-slate-700 mb-1">
                      Currency Symbol
                    </label>
                    <input
                      id="signup-currency"
                      maxLength={4}
                      value={currencySymbol}
                      onChange={(e) => setCurrencySymbol(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label htmlFor="signup-tz" className="block text-xs font-medium text-slate-700 mb-1">
                      Workspace Timezone
                    </label>
                    <input
                      id="signup-tz"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-60"
                >
                  {loading ? 'Creating Workspace...' : 'Create Business Account'}
                </button>
              </form>
            </>
          )}

          {mode === 'reset' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Reset your password</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Enter a one-time reset token issued by your workspace Admin, or check email delivery status below.
                </p>
              </div>

              <form onSubmit={handleCompleteReset} noValidate className="space-y-3.5">
                <div>
                  <label htmlFor="reset-token" className="block text-xs font-medium text-slate-700 mb-1">
                    One-Time Reset Token *
                  </label>
                  <input
                    id="reset-token"
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    placeholder="Paste token issued by workspace Admin"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  {fieldErrors.resetToken && (
                    <p className="mt-1 text-xs text-red-600">{fieldErrors.resetToken}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="reset-new-pw" className="block text-xs font-medium text-slate-700 mb-1">
                    New Password * (min 8 chars, letters + numbers)
                  </label>
                  <input
                    id="reset-new-pw"
                    type="password"
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  {fieldErrors.resetNewPassword && (
                    <p className="mt-1 text-xs text-red-600">{fieldErrors.resetNewPassword}</p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex items-center justify-center gap-1.5 w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
                >
                  <KeyRound className="w-4 h-4" aria-hidden="true" />
                  <span>{loading ? 'Updating Password...' : 'Update Password with Token'}</span>
                </button>
              </form>

              <form onSubmit={handleRequestResetInfo} className="pt-4 border-t border-slate-200 space-y-2.5">
                <div className="text-xs font-medium text-slate-700">Need a reset email sent?</div>
                <div className="flex gap-2">
                  <input
                    type="email"
                    aria-label="Email for password reset instructions"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 whitespace-nowrap"
                  >
                    Request Reset
                  </button>
                </div>
                {fieldErrors.resetEmail && (
                  <p className="text-xs text-red-600">{fieldErrors.resetEmail}</p>
                )}
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
