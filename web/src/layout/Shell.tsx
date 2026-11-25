import { Link, Outlet } from "@tanstack/react-router";
import {
  Activity,
  CalendarDays,
  KeyRound,
  LogIn,
  LogOut,
  Map,
  Package,
  Plug,
  Plus,
  Settings,
  ShoppingBag,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";
import { useLiveUpdates, type LiveState } from "../api/events";
import { SetupPage, SignInPage } from "../auth/AuthPages";
import { useSession, useSignOut } from "../auth/session";
import { ErrorNotice, Spinner } from "../components/ui";
import { useTheme, type ThemeChoice } from "../lib/theme";
import { AddParcelDialog } from "../parcels/AddParcelDialog";
import { BRAND, t } from "../i18n";
import { ReaderNotice } from "./ReaderNotice";

const NAV = [
  { to: "/", label: t.shell.nav.parcels, icon: Package },
  { to: "/map", label: t.shell.nav.map, icon: Map },
  { to: "/orders", label: t.shell.nav.orders, icon: ShoppingBag },
  { to: "/returns", label: t.shell.nav.returns, icon: Undo2 },
  { to: "/calendar", label: t.shell.nav.calendar, icon: CalendarDays },
  { to: "/connections", label: t.shell.nav.connections, icon: Plug },
  { to: "/tokens", label: t.shell.nav.tokens, icon: KeyRound, adminOnly: true },
  { to: "/status", label: t.shell.nav.status, icon: Activity },
  { to: "/settings", label: t.shell.nav.settings, icon: Settings },
] as const satisfies readonly {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Hidden from readers. */
  adminOnly?: true;
}[];

const LIVE_LABELS: Readonly<Record<LiveState, string>> = t.shell.live;

function ThemePicker(): ReactNode {
  const [theme, setTheme] = useTheme();
  return (
    <label className="theme-picker">
      <span className="visually-hidden">{t.shell.theme}</span>
      <select
        value={theme}
        onChange={(e) => {
          setTheme(e.target.value as ThemeChoice);
        }}
      >
        <option value="system">{t.shell.themes.system}</option>
        <option value="dark">{t.shell.themes.dark}</option>
        <option value="light">{t.shell.themes.light}</option>
      </select>
    </label>
  );
}

const ROLE_LABELS = t.shell.roles;

export function Shell(): ReactNode {
  const session = useSession();
  const signOut = useSignOut();
  const live = useLiveUpdates(true);
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const method = session.data?.method ?? null;
  const admin = session.data?.role === "admin";
  const roleLabel = admin
    ? ROLE_LABELS.admin
    : method === "anonymous"
      ? ROLE_LABELS.anonymous
      : ROLE_LABELS.reader;

  // Once the admin is logged in, the header's login is done: a later drop to reader (password
  // changed elsewhere) shows the read-only web UI with its Log in button, not the login page.
  if (signingIn && admin) {
    setSigningIn(false);
  }

  // Reading is open (or a reader logged in) and the admin asked to log in from the header.
  if (signingIn && !admin) {
    const back = (): void => {
      setSigningIn(false);
    };
    return session.data?.setup_required === true ? (
      <SetupPage onCancel={back} />
    ) : (
      <SignInPage onCancel={back} />
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t.shell.skip}
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <img className="brand-logo" src="favicon.svg" alt="" />
          {BRAND}
        </Link>
        <nav aria-label={t.shell.mainNav}>
          <ul className="nav">
            {NAV.filter((item) => admin || !("adminOnly" in item)).map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  title={item.label}
                  activeOptions={{ exact: item.to === "/" }}
                  activeProps={{ "aria-current": "page", className: "active" }}
                >
                  <item.icon size={15} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="topbar-tools">
          {admin ? (
            <button
              type="button"
              className="header-link"
              onClick={() => {
                setAdding(true);
              }}
            >
              <Plus size={16} aria-hidden="true" />
              {t.shell.add}
            </button>
          ) : null}
          <span className={`live live-${live}`} role="status" title={t.shell.liveUpdates}>
            {LIVE_LABELS[live]}
          </span>
          <ThemePicker />
          <span
            className={`badge role-badge role-${admin ? "admin" : "reader"}`}
            title={admin ? t.shell.mayChange : t.shell.mayRead}
          >
            {roleLabel}
          </span>
          {admin || method === "ingress" ? null : (
            <button
              type="button"
              className="header-link"
              onClick={() => {
                setSigningIn(true);
              }}
            >
              <LogIn size={16} aria-hidden="true" />
              {t.shell.logIn}
            </button>
          )}
          {method !== "session" ? null : (
            <button
              type="button"
              className="header-link"
              onClick={() => {
                setSigningIn(false);
                signOut.mutate();
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              {t.shell.logOut}
            </button>
          )}
        </div>
      </header>
      <main id="main" className="content">
        {signOut.isError ? <ErrorNotice error={signOut.error} /> : null}
        <ReaderNotice />
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
      <AddParcelDialog
        open={adding && admin}
        onClose={() => {
          setAdding(false);
        }}
      />
    </div>
  );
}
