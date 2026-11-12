"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ArrowLeft from "lucide-react/icons/arrow-left";
import ArrowRight from "lucide-react/icons/arrow-right";
import Database from "lucide-react/icons/database";
import Download from "lucide-react/icons/download";
import ExternalLink from "lucide-react/icons/external-link";
import Eye from "lucide-react/icons/eye";
import ShieldCheck from "lucide-react/icons/shield-check";
import Trash2 from "lucide-react/icons/trash-2";
import TriangleAlert from "lucide-react/icons/triangle-alert";
import { AppLocaleProvider, useAppLocale } from "@/components/app-locale";
import {
  APP_LOCALE_STORAGE_KEY,
  LEGACY_LANDING_LOCALE_STORAGE_KEY,
} from "@/lib/app-locale";
import {
  DASHBOARD_PREFERENCES_KEY,
  ONBOARDING_DRAFT_KEY,
} from "@/lib/onboarding-draft";
import { DATA_DELETION_CONFIRMATION } from "@/lib/account-data-constants";
import {
  type LegalPageKind,
  legalPageCopy,
} from "./legal-copy";
import styles from "./legal-page.module.css";

const publicRepositoryUrl = "https://github.com/jonxsong/omnigaze";
const signOutPath = "/signout-with-chatgpt?return_to=%2F";

type ActionPhase = "idle" | "working" | "success" | "error";

export interface LegalPageProps {
  kind: LegalPageKind;
  isAuthenticated?: boolean;
  signInPath?: string;
}

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function snapshotFilename(contentDisposition: string | null) {
  const candidate = /filename="?([^";]+)"?/i.exec(contentDisposition ?? "")?.[1]?.trim();
  return candidate && /^[a-z0-9][a-z0-9._-]{0,119}\.json$/i.test(candidate)
    ? candidate
    : "omnigaze-saved-data-snapshot.json";
}

function DataExportControl({
  isAuthenticated,
  signInPath,
}: Required<Pick<LegalPageProps, "isAuthenticated" | "signInPath">>) {
  const { locale } = useAppLocale();
  const copy = legalPageCopy[locale].snapshot;
  const [phase, setPhase] = useState<ActionPhase>("idle");

  async function downloadSnapshot() {
    if (phase === "working") return;
    setPhase("working");
    try {
      const response = await fetch("/api/account/data-export", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "json" }),
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.toLowerCase().includes("application/json")
      ) {
        throw new Error("account_data_export_failed");
      }

      const objectUrl = window.URL.createObjectURL(await response.blob());
      const link = window.document.createElement("a");
      link.href = objectUrl;
      link.download = snapshotFilename(response.headers.get("content-disposition"));
      link.hidden = true;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1_000);
      setPhase("success");
    } catch {
      setPhase("error");
    }
  }

  return (
    <section className={styles.exportPanel} aria-labelledby="download-account-data-title">
      <Download size={22} aria-hidden="true" />
      <div>
        <h2 id="download-account-data-title">{copy.title}</h2>
        <p>{isAuthenticated ? copy.body : copy.anonymousBody}</p>
        {isAuthenticated ? (
          <div className={styles.exportActions}>
            <button
              type="button"
              disabled={phase === "working"}
              onClick={downloadSnapshot}
            >
              <Download size={14} aria-hidden="true" />
              {phase === "working" ? copy.working : copy.action}
            </button>
            {phase === "success" && (
              <p className={styles.exportSuccess} role="status">
                <ShieldCheck size={14} aria-hidden="true" />
                <span><strong>{copy.successTitle}</strong> {copy.successBody}</span>
              </p>
            )}
            {phase === "error" && (
              <p className={styles.deletionError} role="alert">
                <TriangleAlert size={14} aria-hidden="true" /> {copy.failure}
              </p>
            )}
          </div>
        ) : (
          <a className={styles.signInAction} href={signInPath} target="_top">
            {copy.signIn} <ArrowRight size={14} />
          </a>
        )}
      </div>
    </section>
  );
}

function DataDeletionControl({
  isAuthenticated,
  signInPath,
}: Required<Pick<LegalPageProps, "isAuthenticated" | "signInPath">>) {
  const { locale } = useAppLocale();
  const copy = legalPageCopy[locale].deletion;
  const [confirmation, setConfirmation] = useState("");
  const [phase, setPhase] = useState<ActionPhase>("idle");

  async function deleteAccountData() {
    if (confirmation !== DATA_DELETION_CONFIRMATION || phase === "working") return;
    setPhase("working");
    try {
      const challengeResponse = await fetch(
        "/api/account/data-deletion-challenge",
        { method: "POST", credentials: "same-origin" },
      );
      if (!challengeResponse.ok) {
        throw new Error("account_data_deletion_challenge_failed");
      }
      const challengePayload = (await challengeResponse.json()) as {
        data?: { challenge?: string; confirmationPhrase?: string };
      };
      const challenge = challengePayload.data?.challenge;
      if (
        !challenge ||
        challengePayload.data?.confirmationPhrase !== DATA_DELETION_CONFIRMATION
      ) {
        throw new Error("account_data_deletion_challenge_invalid");
      }
      const response = await fetch("/api/account/data", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge,
          confirmation: DATA_DELETION_CONFIRMATION,
        }),
      });
      if (!response.ok) throw new Error("account_data_deletion_failed");

      for (const key of [
        ONBOARDING_DRAFT_KEY,
        DASHBOARD_PREFERENCES_KEY,
        APP_LOCALE_STORAGE_KEY,
        LEGACY_LANDING_LOCALE_STORAGE_KEY,
      ]) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Server deletion is authoritative even when browser storage is restricted.
        }
      }
      setConfirmation("");
      setPhase("success");
      const signOutLink = window.document.createElement("a");
      signOutLink.href = signOutPath;
      signOutLink.target = "_top";
      signOutLink.click();
    } catch {
      setPhase("error");
    }
  }

  if (phase === "success") {
    return (
      <section className={`${styles.deletionPanel} ${styles.deletionSuccess}`} aria-live="polite">
        <ShieldCheck size={22} aria-hidden="true" />
        <div>
          <h2>{copy.successTitle}</h2>
          <p>{copy.successBody}</p>
          <a href={signOutPath} target="_top">{copy.dashboard} <ArrowRight size={14} /></a>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.deletionPanel} aria-labelledby="delete-account-data-title">
      <Trash2 size={22} aria-hidden="true" />
      <div>
        <h2 id="delete-account-data-title">{copy.title}</h2>
        <p>{isAuthenticated ? copy.body : copy.anonymousBody}</p>
        {isAuthenticated ? (
          <div className={styles.deletionForm}>
            <label htmlFor="delete-account-confirmation">{copy.confirmationLabel}</label>
            <span id="delete-account-confirmation-hint">{copy.confirmationHint}</span>
            <div>
              <input
                id="delete-account-confirmation"
                value={confirmation}
                placeholder={copy.confirmationPlaceholder}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="delete-account-confirmation-hint"
                disabled={phase === "working"}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  if (phase === "error") setPhase("idle");
                }}
              />
              <button
                type="button"
                disabled={confirmation !== DATA_DELETION_CONFIRMATION || phase === "working"}
                onClick={deleteAccountData}
              >
                <Trash2 size={14} aria-hidden="true" />
                {phase === "working" ? copy.working : copy.action}
              </button>
            </div>
            {phase === "error" && (
              <p className={styles.deletionError} role="alert">
                <TriangleAlert size={14} aria-hidden="true" /> {copy.failure}
              </p>
            )}
          </div>
        ) : (
          <a className={styles.signInAction} href={signInPath} target="_top">
            {copy.signIn} <ArrowRight size={14} />
          </a>
        )}
      </div>
    </section>
  );
}

function LegalPageContent({
  kind,
  isAuthenticated = false,
  signInPath = "/signin-with-chatgpt?return_to=%2Fdata-and-deletion",
}: LegalPageProps) {
  const { hydrated, locale, setLocale } = useAppLocale();
  const copy = legalPageCopy[locale];
  const policyDocument = copy.documents[kind];

  useEffect(() => {
    window.document.title = `${policyDocument.title} — Omnigaze`;
  }, [policyDocument.title]);

  return (
    <main
      className={styles.page}
      lang={locale}
      data-hydrated={hydrated ? "true" : "false"}
    >
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Omnigaze home">
          <BrandMark />
          <span><strong>OMNIGAZE</strong><small>ALPHA</small></span>
        </Link>
        <nav aria-label={copy.navigation.headerLegal}>
          <Link href="/privacy" aria-current={kind === "privacy" ? "page" : undefined}>
            {copy.navigation.privacy}
          </Link>
          <Link href="/terms" aria-current={kind === "terms" ? "page" : undefined}>
            {copy.navigation.terms}
          </Link>
          <Link href="/data-and-deletion" aria-current={kind === "data" ? "page" : undefined}>
            {copy.navigation.data}
          </Link>
        </nav>
        <div className={styles.headerActions}>
          <div className={styles.localeToggle} role="group" aria-label={copy.locale.group}>
            <button
              type="button"
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <button
              type="button"
              aria-pressed={locale === "zh-CN"}
              onClick={() => setLocale("zh-CN")}
            >
              中文
            </button>
          </div>
          <Link className={styles.dashboardLink} href="/dashboard">
            {copy.navigation.dashboard} <ArrowRight size={13} />
          </Link>
        </div>
      </header>

      <div className={styles.content}>
        <Link className={styles.backLink} href="/">
          <ArrowLeft size={14} /> {copy.navigation.home}
        </Link>

        <section className={styles.hero} aria-labelledby="legal-page-title">
          <div className={styles.heroIcon} aria-hidden="true">
            {kind === "privacy" ? <ShieldCheck /> : kind === "terms" ? <Eye /> : <Database />}
          </div>
          <span className={styles.eyebrow}>{policyDocument.eyebrow}</span>
          <h1 id="legal-page-title">{policyDocument.title}</h1>
          <p>{policyDocument.summary}</p>
          <div className={styles.metaRow}>
            <span>{copy.effective}</span>
            <span>{copy.updated}</span>
          </div>
        </section>

        <aside className={styles.statusCard}>
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>{policyDocument.status}</strong>
            <span>{copy.researchBoundary}</span>
          </div>
        </aside>

        <div className={styles.documentGrid}>
          <aside className={styles.tableOfContents} aria-label={copy.navigation.legal}>
            {policyDocument.sections.map((section, index) => (
              <a href={`#${section.id}`} key={section.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {section.title}
              </a>
            ))}
          </aside>

          <article className={styles.document}>
            {policyDocument.sections.map((section, index) => (
              <section id={section.id} key={section.id}>
                <span className={styles.sectionNumber} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h2>{section.title}</h2>
                {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.bullets && (
                  <ul>
                    {section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                  </ul>
                )}
              </section>
            ))}
          </article>
        </div>

        {kind === "data" && (
          <div className={styles.dataControls}>
            <DataExportControl
              isAuthenticated={isAuthenticated}
              signInPath={signInPath}
            />
            <DataDeletionControl
              isAuthenticated={isAuthenticated}
              signInPath={signInPath}
            />
          </div>
        )}

        <footer className={styles.footer}>
          <div>
            <BrandMark />
            <span><strong>OMNIGAZE</strong><small>{copy.researchBoundary}</small></span>
          </div>
          <nav aria-label={copy.navigation.footerLegal}>
            <Link href="/privacy">{copy.navigation.privacy}</Link>
            <Link href="/terms">{copy.navigation.terms}</Link>
            <Link href="/data-and-deletion">{copy.navigation.data}</Link>
            <a href={publicRepositoryUrl} target="_blank" rel="noreferrer">
              GitHub <ExternalLink size={11} />
            </a>
          </nav>
        </footer>
      </div>
    </main>
  );
}

export function LegalPage(props: LegalPageProps) {
  return (
    <AppLocaleProvider>
      <LegalPageContent {...props} />
    </AppLocaleProvider>
  );
}

