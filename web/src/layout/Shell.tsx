import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  CalendarDays,
  KeyRound,
  LogIn,
  LogOut,
  Map,
  Menu,
  Monitor,
  Moon,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Settings,
  ShoppingBag,
  Sun,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";
import { useLiveUpdates, type LiveState } from "../api/events";
import { SetupPage, SignInPage } from "../auth/AuthPages";
import { useSession, useSignOut } from "../auth/session";
import { Dialog, ErrorNotice, Spinner } from "../components/ui";
import { NARROW, useMediaQuery } from "../lib/media";
import { useTheme, type ThemeChoice } from "../lib/theme";
import { AddParcelDialog } from "../parcels/AddParcelDialog";
import { BRAND, t } from "../i18n";
import { ReaderNotice } from "./ReaderNotice";
import "./shell.css";

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Everyday pages, or the setup and admin pages kept apart below them. */
  readonly group: "main" | "manage";
  /** One of the phone's bottom tabs; the rest sit behind "More". */
  readonly tab?: true;
  /** Hidden from readers. */
  readonly adminOnly?: true;
}

/** Every page in the navigation, in order. A new page is one more entry here. */
const NAV: readonly NavItem[] = [
  { to: "/", label: t.shell.nav.parcels, icon: Package, group: "main", tab: true },
  { to: "/map", label: t.shell.nav.map, icon: Map, group: "main", tab: true },
  { to: "/orders", label: t.shell.nav.orders, icon: ShoppingBag, group: "main", tab: true },
  { to: "/returns", label: t.shell.nav.returns, icon: Undo2, group: "main", tab: true },
  { to: "/calendar", label: t.shell.nav.calendar, icon: CalendarDays, group: "main" },
  { to: "/connections", label: t.shell.nav.connections, icon: Plug, group: "manage" },
  { to: "/tokens", label: t.shell.nav.tokens, icon: KeyRound, group: "manage", adminOnly: true },
  { to: "/status", label: t.shell.nav.status, icon: Activity, group: "manage" },
  { to: "/settings", label: t.shell.nav.settings, icon: Settings, group: "manage" },
];

const LIVE_LABELS: Readonly<Record<LiveState, string>> = t.shell.live;
const ROLE_LABELS = t.shell.roles;
const COLLAPSED_KEY = "open-parcels.sidebar";

const THEMES: readonly { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "system", label: t.shell.themes.system, icon: Monitor },
  { value: "light", label: t.shell.themes.light, icon: Sun },
  { value: "dark", label: t.shell.themes.dark, icon: Moon },
];

/** System, light or dark as three small icon radios. */
function ThemePicker(): ReactNode {
  const [theme, setTheme] = useTheme();
  return (
    <fieldset className="theme-picker">
      <legend className="visually-hidden">{t.shell.theme}</legend>
      {THEMES.map((option) => (
        <label
          key={option.value}
          title={option.label}
          className={theme === option.value ? "selected" : undefined}
        >
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme === option.value}
            onChange={() => {
              setTheme(option.value);
            }}
          />
          <option.icon size={14} aria-hidden="true" />
          <span className="visually-hidden">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function LiveIndicator(props: { readonly live: LiveState }): ReactNode {
  return (
    <span className={`live live-${props.live}`} role="status" title={t.shell.liveUpdates}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">{LIVE_LABELS[props.live]}</span>
    </span>
  );
}

function NavLinks(props: {
  readonly items: readonly NavItem[];
  readonly onNavigate?: () => void;
}): ReactNode {
  return (
    <ul className="nav">
      {props.items.map((item) => (
        <li key={item.to}>
          <Link
            to={item.to}
            title={item.label}
            activeOptions={{ exact: item.to === "/" }}
            activeProps={{ "aria-current": "page", className: "active" }}
            onClick={props.onNavigate}
          >
            <item.icon size={18} aria-hidden="true" />
            <span className="nav-label">{item.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The grouped page links: everyday pages, then the setup and admin ones under a heading. */
function NavGroups(props: {
  readonly items: readonly NavItem[];
  readonly onNavigate?: () => void;
}): ReactNode {
  const manage = props.items.filter((item) => item.group === "manage");
  return (
    <>
      <NavLinks {...props} items={props.items.filter((item) => item.group === "main")} />
      {manage.length === 0 ? null : (
        <>
          <p className="nav-heading">{t.shell.manageNav}</p>
          <NavLinks {...props} items={manage} />
        </>
      )}
    </>
  );
}

interface Account {
  readonly admin: boolean;
  readonly method: string | null;
  readonly onLogIn: () => void;
  readonly onLogOut: () => void;
}

/** Who is signed in, with the way to log in or out. */
function AccountRow(props: Account): ReactNode {
  const { admin, method } = props;
  const roleLabel = admin
    ? ROLE_LABELS.admin
    : method === "anonymous"
      ? ROLE_LABELS.anonymous
      : ROLE_LABELS.reader;
  return (
    <div className="account">
      <span
        className={`badge role-badge role-${admin ? "admin" : "reader"}`}
        title={admin ? t.shell.mayChange : t.shell.mayRead}
      >
        {roleLabel}
      </span>
      {admin || method === "ingress" ? null : (
        <button type="button" className="header-link" onClick={props.onLogIn}>
          <LogIn size={16} aria-hidden="true" />
          <span className="nav-label">{t.shell.logIn}</span>
        </button>
      )}
      {method !== "session" ? null : (
        <button type="button" className="header-link" onClick={props.onLogOut}>
          <LogOut size={16} aria-hidden="true" />
          <span className="nav-label">{t.shell.logOut}</span>
        </button>
      )}
    </div>
  );
}

function Brand(): ReactNode {
  return (
    <Link to="/" className="brand">
      <img className="brand-logo" src="favicon.svg" alt="" />
      <span className="brand-name">{BRAND}</span>
    </Link>
  );
}

function AddButton(props: { readonly onAdd: () => void }): ReactNode {
  return (
    <button type="button" className="add-button" onClick={props.onAdd}>
      <Plus size={16} aria-hidden="true" />
      <span className="add-label">{t.shell.add}</span>
    </button>
  );
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Desktop: a sidebar with the brand, the pages, and live state, theme and account at its foot. */
function Sidebar(
  props: Account & {
    readonly items: readonly NavItem[];
    readonly live: LiveState;
    readonly onAdd: (() => void) | null;
  },
): ReactNode {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "collapsed" : "open");
    } catch {
      // Private mode: the choice lasts until the page reloads.
    }
  };
  return (
    <header className={collapsed ? "sidebar collapsed" : "sidebar"}>
      <div className="sidebar-top">
        <Brand />
        <button
          type="button"
          className="icon-button sidebar-toggle"
          aria-label={collapsed ? t.shell.expand : t.shell.collapse}
          title={collapsed ? t.shell.expand : t.shell.collapse}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={18} aria-hidden="true" />
          )}
        </button>
      </div>
      {props.onAdd === null ? null : <AddButton onAdd={props.onAdd} />}
      <nav aria-label={t.shell.mainNav} className="sidebar-nav">
        <NavGroups items={props.items} />
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-row">
          <LiveIndicator live={props.live} />
          <ThemePicker />
        </div>
        <AccountRow {...props} />
      </div>
    </header>
  );
}

/** Phones: a slim top bar, four tabs at the bottom and the rest in a "More" sheet. */
function MobileBars(
  props: Account & {
    readonly items: readonly NavItem[];
    readonly live: LiveState;
    readonly onAdd: (() => void) | null;
  },
): ReactNode {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const tabs = props.items.filter((item) => item.tab === true);
  const rest = props.items.filter((item) => item.tab !== true);
  const inMore = rest.some((item) => path.startsWith(item.to));
  const close = (): void => {
    setOpen(false);
  };
  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="topbar-tools">
          <LiveIndicator live={props.live} />
          {props.onAdd === null ? null : <AddButton onAdd={props.onAdd} />}
        </div>
      </header>
      <nav aria-label={t.shell.mainNav} className="tabbar">
        <NavLinks items={tabs} />
        <button
          type="button"
          className={inMore ? "tab-more active" : "tab-more"}
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Menu size={18} aria-hidden="true" />
          <span className="nav-label">{t.shell.more}</span>
        </button>
      </nav>
      <Dialog title={t.shell.more} open={open} onClose={close}>
        <div className="more-sheet">
          <nav aria-label={t.shell.more}>
            <NavGroups items={rest} onNavigate={close} />
          </nav>
          <div className="sidebar-row">
            <span className="muted">{t.shell.theme}</span>
            <ThemePicker />
          </div>
          <AccountRow
            {...props}
            onLogIn={() => {
              close();
              props.onLogIn();
            }}
          />
        </div>
      </Dialog>
    </>
  );
}

export function Shell(): ReactNode {
  const session = useSession();
  const signOut = useSignOut();
  const live = useLiveUpdates(true);
  const narrow = useMediaQuery(NARROW);
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const method = session.data?.method ?? null;
  const admin = session.data?.role === "admin";

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

  const chrome = {
    items: NAV.filter((item) => admin || item.adminOnly !== true),
    live,
    admin,
    method,
    onAdd: admin
      ? () => {
          setAdding(true);
        }
      : null,
    onLogIn: () => {
      setSigningIn(true);
    },
    onLogOut: () => {
      setSigningIn(false);
      signOut.mutate();
    },
  };

  return (
    <div className={narrow ? "app app-narrow" : "app"}>
      <a className="skip-link" href="#main">
        {t.shell.skip}
      </a>
      {narrow ? <MobileBars {...chrome} /> : <Sidebar {...chrome} />}
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
