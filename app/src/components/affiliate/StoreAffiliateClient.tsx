"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Loader2, Search, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildAffiliateLink,
  COMMISSION_STATUS_LABELS,
  maskAccountNo,
  normalizeSubId,
  type AffiliateCommissionStatus,
  type AffiliateStatus,
} from "@/lib/affiliate/program";

type Program = {
  open: boolean;
  joinMode: "open" | "approval";
  commissionPercent: number | null;
  attributionDays: number;
  confirmAfterDays: number;
  minPayoutAmount: number;
  terms: string;
  termsVersion: number;
};

type Account = {
  code: string;
  name: string;
  status: AffiliateStatus;
  statusLabel: string;
  reviewNote: string;
  bankName: string;
  bankAccountNo: string;
  bankAccountName: string;
  termsVersionAccepted: number | null;
};

type Commission = {
  order: string;
  channel: string;
  subId: string;
  goods: number;
  percent: number;
  amount: number;
  status: AffiliateCommissionStatus;
  orderedAt: string;
};

type Payout = {
  amount: number;
  count: number;
  reference: string;
  paidAt: string;
};

type Data = {
  signedIn: boolean;
  email?: string;
  program: Program;
  affiliate: Account | null;
  totals?: {
    pending: number;
    confirmed: number;
    paid: number;
    cancelled: number;
    orders: number;
  };
  commissions?: Commission[];
  payouts?: Payout[];
};

type LinkProduct = {
  id: string;
  name: string;
  imageUrl: string | null;
  channel: "store" | "outdoor";
  path: string;
};

type BankForm = {
  bankType: "bank" | "ewallet";
  bankName: string;
  bankAccountNo: string;
  bankAccountName: string;
};

const MALAYSIAN_BANKS = [
  { value: "Maybank", label: "Maybank" },
  { value: "CIMB", label: "CIMB Bank" },
  { value: "Public Bank", label: "Public Bank" },
  { value: "RHB Bank", label: "RHB Bank" },
  { value: "AmBank", label: "AmBank" },
  { value: "Hong Leong Bank", label: "Hong Leong Bank" },
  { value: "UOB", label: "UOB Malaysia" },
  { value: "OCBC", label: "OCBC Bank" },
  { value: "HSBC", label: "HSBC Malaysia" },
  { value: "Standard Chartered", label: "Standard Chartered" },
] as const;

const MALAYSIAN_EWALLETS = [
  { value: "Touch 'n Go eWallet", label: "Touch 'n Go eWallet" },
  { value: "GrabPay", label: "GrabPay" },
  { value: "Boost", label: "Boost" },
  { value: "ShopeePay", label: "ShopeePay" },
  { value: "MAE", label: "MAE by Maybank" },
  { value: "BigPay", label: "BigPay" },
] as const;

function bankAccountMaxLength(bankType: string, bankName: string): number {
  if (bankType === "ewallet") return 20;
  if (bankName === "Touch 'n Go eWallet") return 12;
  if (bankName === "GrabPay") return 12;
  if (bankName === "Boost") return 12;
  if (bankName === "ShopeePay") return 12;
  if (bankName === "MAE") return 12;
  if (bankName === "BigPay") return 12;
  return 16;
}

const SIGNED_OUT_PROGRAM: Program = {
  open: false,
  joinMode: "open",
  commissionPercent: null,
  attributionDays: 30,
  confirmAfterDays: 7,
  minPayoutAmount: 0,
  terms: "",
  termsVersion: 1,
};

const card =
  "rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] p-5 sm:p-6";
const field = "h-11 rounded-xl";

function rm(value: number) {
  return `RM ${(Number(value) || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function day(iso: string) {
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? new Date(at).toLocaleDateString("en-MY", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
}

function percentText(value: number | null) {
  return value == null
    ? ""
    : `${Number(value).toLocaleString("en-MY", { maximumFractionDigits: 2 })}%`;
}

function mediaUrl(raw: string | null) {
  if (!raw) return null;
  if (/\.(mp4|webm|mov)(\?|$)/i.test(raw)) return null;
  if (/^https?:\/\//.test(raw)) return raw;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  const path = raw.replace(/^\/+/, "");
  const bucket = ["product-variants", "avatars"].find((b) =>
    path.startsWith(`${b}/`),
  );
  return bucket
    ? `${base}/storage/v1/object/public/${bucket}/${path.slice(bucket.length + 1)}`
    : `${base}/storage/v1/object/public/avatars/${path}`;
}

function Notice({
  tone,
  children,
}: {
  tone: "ok" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-3 text-sm ${tone === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}
    >
      {children}
    </div>
  );
}

function BankFields({
  value,
  onChange,
}: {
  value: BankForm;
  onChange: (next: BankForm) => void;
}) {
  const isEwallet = value.bankType === "ewallet";
  const allOptions = isEwallet ? MALAYSIAN_EWALLETS : MALAYSIAN_BANKS;
  const maxLen = bankAccountMaxLength(value.bankType, value.bankName);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">
          Account type
        </Label>
        <Select
          value={value.bankType as string}
          onValueChange={(next) =>
            onChange({
              ...value,
              bankType: next as "bank" | "ewallet",
              bankName: "",
              bankAccountNo: "",
            })
          }
        >
          <SelectTrigger className={field}>
            <SelectValue placeholder="Bank or eWallet" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bank">Bank account</SelectItem>
            <SelectItem value="ewallet">eWallet</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">
          Bank name
        </Label>
        <Select
          value={value.bankName}
          onValueChange={(next) =>
            onChange({ ...value, bankName: next, bankAccountNo: "" })
          }
        >
          <SelectTrigger className={field}>
            <SelectValue placeholder="Select bank or eWallet" />
          </SelectTrigger>
          <SelectContent>
            {allOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">
          Account number
        </Label>
        <Input
          className={`${field} tabular-nums`}
          value={value.bankAccountNo}
          inputMode="numeric"
          maxLength={maxLen}
          placeholder="Digits only"
          onChange={(e) =>
            onChange({ ...value, bankAccountNo: e.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">
          Name on account
        </Label>
        <Input
          className={field}
          value={value.bankAccountName}
          maxLength={120}
          placeholder="As shown on your statement"
          onChange={(e) =>
            onChange({ ...value, bankAccountName: e.target.value })
          }
        />
      </div>
    </div>
  );
}

function CopyButton({
  text,
  label = "Copy link",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      disabled={!text}
      className="h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          window.prompt("Copy this link", text);
        }
      }}
    >
      {done ? (
        <Check className="mr-2 h-4 w-4" />
      ) : (
        <Copy className="mr-2 h-4 w-4" />
      )}
      {done ? "Copied" : label}
    </Button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <Link
        href="/store/account"
        className="mb-6 inline-flex items-center gap-1 text-sm text-[var(--sera-muted)] hover:text-[var(--sera-ink)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export default function StoreAffiliateClient() {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [bank, setBank] = useState<BankForm>({
    bankType: "bank",
    bankName: "",
    bankAccountNo: "",
    bankAccountName: "",
  });
  const [agree, setAgree] = useState(false);
  const [editBank, setEditBank] = useState(false);
  const [products, setProducts] = useState<LinkProduct[] | null>(null);
  const [productQuery, setProductQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<LinkProduct | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/affiliate/me", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.status === 401) {
        setData({
          signedIn: false,
          program: SIGNED_OUT_PROGRAM,
          affiliate: null,
        });
        return;
      }
      if (!res.ok || !json) throw new Error(json?.error || "Could not load.");
      setData(json);
      const account: Account | null = json.affiliate;
      if (account) {
        const isEwallet = MALAYSIAN_EWALLETS.some(
          (e) => e.value === account.bankName,
        );
        setBank({
          bankType: isEwallet ? "ewallet" : "bank",
          bankName: account.bankName,
          bankAccountNo: account.bankAccountNo,
          bankAccountName: account.bankAccountName,
        });
      }
    } catch (err: any) {
      setLoadError(err.message || "Could not load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approved =
    data?.affiliate?.status === "approved" &&
    data.program.open &&
    data.affiliate.termsVersionAccepted === data.program.termsVersion;

  useEffect(() => {
    if (!approved || products) return;
    fetch("/api/affiliate/me?links=1", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) =>
        setProducts(Array.isArray(json?.products) ? json.products : []),
      )
      .catch(() => setProducts([]));
  }, [approved, products]);

  const post = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/affiliate/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || "Could not save.");
      setMessage({ ok: true, text: done });
      setEditBank(false);
      await load();
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || "Could not save." });
    } finally {
      setBusy(false);
    }
  };

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const code = data?.affiliate?.code || "";
  const target = selectedProduct
    ? `${origin}${selectedProduct.path}`
    : `${origin}/store`;
  const link = useMemo(
    () => (code && origin ? buildAffiliateLink(target, code) : ""),
    [code, origin, target],
  );
  const homeLink = useMemo(
    () => (code && origin ? buildAffiliateLink(`${origin}/store`, code) : ""),
    [code, origin],
  );
  const shownProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    return (products || []).filter(
      (p) => !q || p.name.toLowerCase().includes(q),
    );
  }, [products, productQuery]);

  if (loadError) {
    return (
      <Shell>
        <Notice tone="error">{loadError}</Notice>
      </Shell>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--sera-orange)]" />
      </div>
    );
  }

  const { program, affiliate } = data;
  const rate = percentText(program.commissionPercent);
  const needsTerms = Boolean(
    affiliate &&
    affiliate.status !== "rejected" &&
    affiliate.termsVersionAccepted !== program.termsVersion,
  );
  const showJoin = !affiliate || affiliate.status === "rejected";

  if (!data.signedIn) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">
          Affiliate program
        </h1>
        <p className="text-sm leading-relaxed text-[var(--sera-muted)]">
          Share Serapod products and earn commission on paid orders.
        </p>
        <Button
          asChild
          className="h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
        >
          <Link href="/login?next=/store/affiliate">Sign in to join</Link>
        </Button>
      </Shell>
    );
  }

  if (!affiliate && !program.open) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">
          Affiliate program
        </h1>
        <p className="text-sm text-[var(--sera-muted)]">
          The affiliate program is not open for new applications yet.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div>
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">
          Affiliate program
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--sera-muted)]">
          {rate
            ? `Earn ${rate} commission when someone buys through your link.`
            : "Share Serapod products and earn commission on paid orders."}
        </p>
        {rate ? (
          <p className="mt-3 font-display text-3xl font-semibold text-[var(--sera-ink)]">
            {rate}
          </p>
        ) : null}
      </div>

      {message ? (
        <Notice tone={message.ok ? "ok" : "error"}>{message.text}</Notice>
      ) : null}

      {needsTerms && program.open ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">
            Accept updated terms
          </h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">
            The program terms changed. Accept them before your links earn again.
          </p>
          {program.terms ? (
            <div className="mt-4 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-3 text-sm text-[var(--sera-muted)]">
              {program.terms}
            </div>
          ) : null}
          <label className="mt-4 flex items-start gap-2 text-sm text-[var(--sera-ink)]">
            <input
              type="checkbox"
              className="mt-1"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            I agree to the current affiliate program terms.
          </label>
          <Button
            type="button"
            className="mt-4 h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
            disabled={busy || !agree}
            onClick={() =>
              post(
                { action: "accept_terms", agree },
                "Terms accepted. Your links are active again.",
              )
            }
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Accept updated terms
          </Button>
        </section>
      ) : null}

      {showJoin && program.open ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">
            Join the affiliate program
          </h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">
            {program.joinMode === "approval"
              ? "We review applications before your link goes live."
              : "Your link is ready as soon as you join."}
            {data.email ? ` Joining as ${data.email}.` : ""}
          </p>
          <div className="mt-5">
            <BankFields value={bank} onChange={setBank} />
          </div>
          {program.terms ? (
            <div className="mt-5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-3 text-sm text-[var(--sera-muted)]">
              {program.terms}
            </div>
          ) : null}
          <label className="mt-4 flex items-start gap-2 text-sm text-[var(--sera-ink)]">
            <input
              type="checkbox"
              className="mt-1"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            I agree to the affiliate program terms.
          </label>
          <Button
            type="button"
            className="mt-5 h-11 w-full rounded-xl bg-gradient-to-r from-[var(--sera-orange)] to-[var(--sera-orange-deep)] font-semibold text-white hover:from-[var(--sera-orange-deep)] hover:to-[var(--sera-orange-deep)]"
            disabled={busy || !agree}
            onClick={() =>
              post(
                { action: "join", agree, ...bank },
                program.joinMode === "approval"
                  ? "Application sent. We will email you after review."
                  : "You have joined. Your link is ready.",
              )
            }
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {program.joinMode === "approval" ? "Apply now" : "Join"}
          </Button>
        </section>
      ) : null}

      {affiliate && affiliate.status === "pending" ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">
            Application received
          </h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">
            We are reviewing it. Your link appears here once it is approved.
          </p>
        </section>
      ) : null}

      {affiliate && affiliate.status === "suspended" ? (
        <Notice tone="error">
          Your affiliate account is suspended.
          {affiliate.reviewNote ? ` ${affiliate.reviewNote}` : ""} Links do not
          earn while it stays suspended.
        </Notice>
      ) : null}

      {affiliate && affiliate.status === "approved" && !program.open ? (
        <Notice tone="error">
          The affiliate program is paused. Your balance stays, and links do not
          earn until it opens again.
        </Notice>
      ) : null}

      {approved ? (
        <section className={card}>
          <p className="text-sm text-[var(--sera-muted)]">
            Your affiliate code
          </p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-tight text-[var(--sera-ink)]">
            {code}
          </p>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">
            {affiliate?.statusLabel}
            {rate ? ` · ${rate}` : ""}
          </p>
          <div className="mt-4">
            <CopyButton text={homeLink} label="Copy store link" />
          </div>
        </section>
      ) : null}

      {affiliate &&
      affiliate.status !== "rejected" &&
      affiliate.status !== "pending" &&
      data.totals ? (
        <section className="grid gap-3 sm:grid-cols-3">
          {[
            {
              label: "Pending",
              value: data.totals.pending,
              hint: "Inside refund window",
            },
            {
              label: "Ready to pay",
              value: data.totals.confirmed,
              hint: "Waiting for transfer",
            },
            { label: "Paid", value: data.totals.paid, hint: "Already sent" },
          ].map((box) => (
            <div key={box.label} className={card}>
              <p className="text-sm text-[var(--sera-muted)]">{box.label}</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-[var(--sera-ink)]">
                <span>{rm(box.value)}</span>
              </p>
              <p className="mt-1 text-xs text-[var(--sera-muted)]">
                {box.hint}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {approved ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">
            Create your affiliate link
          </h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">
            Choose what you want to share. Anyone who buys through your link
            earns you commission.
          </p>
          <div className="mt-4 grid gap-3">
            <button
              type="button"
              onClick={() => setSelectedProduct(null)}
              className={`flex items-center justify-between gap-3 rounded-xl border p-4 text-left ${!selectedProduct ? "border-[var(--sera-orange)] bg-white" : "border-[var(--sera-line)] bg-white/70"}`}
            >
              <div>
                <p className="font-medium text-[var(--sera-ink)]">
                  Whole store link
                </p>
                <p className="text-xs text-[var(--sera-muted)]">
                  Any product in the Serapod store
                </p>
              </div>
              {!selectedProduct ? (
                <Check className="h-5 w-5 text-[var(--sera-orange)]" />
              ) : null}
            </button>
            <button
              type="button"
              onClick={() =>
                setSelectedProduct({
                  id: "custom",
                  name: "Custom Product",
                  path: "/store/custom",
                  imageUrl: null,
                  channel: "store",
                } as LinkProduct)
              }
              className={`flex items-center justify-between gap-3 rounded-xl border p-4 text-left ${selectedProduct?.id === "custom" ? "border-[var(--sera-orange)] bg-white" : "border-[var(--sera-line)] bg-white/70"}`}
            >
              <div>
                <p className="font-medium text-[var(--sera-ink)]">
                  Custom Product
                </p>
                <p className="text-xs text-[var(--sera-muted)]">
                  Your own custom product link
                </p>
              </div>
              {selectedProduct?.id === "custom" ? (
                <Check className="h-5 w-5 text-[var(--sera-orange)]" />
              ) : null}
            </button>
            {selectedProduct ? (
              <>
                {products === null ? (
                  <p className="col-span-full py-6 text-sm text-[var(--sera-muted)]">
                    Loading products…
                  </p>
                ) : shownProducts.length === 0 ? (
                  <p className="col-span-full py-6 text-sm text-[var(--sera-muted)]">
                    No products found.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {shownProducts.map((product) => {
                      const img = mediaUrl(product.imageUrl);
                      const active = selectedProduct?.id === product.id;
                      return (
                        <button
                          key={`${product.channel}-${product.id}`}
                          type="button"
                          onClick={() => setSelectedProduct(product)}
                          className={`flex flex-col gap-2 rounded-xl border p-3 text-left ${active ? "border-[var(--sera-orange)] bg-white" : "border-[var(--sera-line)] bg-white/70 hover:border-[var(--sera-line)] hover:bg-white"}`}
                        >
                          <span className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-[var(--sera-paper)]">
                            {img ? (
                              <img
                                src={img}
                                alt=""
                                className="h-full w-full object-contain"
                              />
                            ) : null}
                          </span>
                          <span className="line-clamp-2 block text-xs font-medium text-[var(--sera-ink)]">
                            {product.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : null}
          </div>
          <div className="mt-5 space-y-3">
            <div className="rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-4">
              <p className="text-xs text-[var(--sera-muted)]">
                Your affiliate link
              </p>
              <p className="mt-1 break-all text-sm text-[var(--sera-ink)]">
                {link || "Choose an option above to build the link."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={link} />
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl"
                disabled={!link}
                onClick={() => {
                  const share = navigator.share;
                  if (typeof share === "function")
                    share.call(navigator, { url: link }).catch(() => undefined);
                  else
                    navigator.clipboard?.writeText(link).catch(() => undefined);
                }}
              >
                <Share2 className="mr-2 h-4 w-4" /> Share
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {affiliate &&
      affiliate.status !== "rejected" &&
      affiliate.status !== "pending" &&
      data.totals ? (
        <>
          <section className={card}>
            <h2 className="text-base font-semibold text-[var(--sera-ink)]">
              Orders
            </h2>
            <p className="mt-1 text-sm text-[var(--sera-muted)]">
              Confirmed {program.confirmAfterDays} days after delivery.
            </p>
            {data.commissions && data.commissions.length > 0 ? (
              <ul className="mt-4 divide-y divide-[var(--sera-line)]">
                {data.commissions.map((row, index) => (
                  <li
                    key={`${row.order}-${index}`}
                    className="flex items-start justify-between gap-3 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-[var(--sera-ink)]">
                        {row.channel} {row.order}
                      </p>
                      <p className="mt-0.5 text-[var(--sera-muted)]">
                        {day(row.orderedAt)} · {rm(row.goods)}
                        {row.subId ? (
                          <>
                            {" "}
                            · <span>{row.subId}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium tabular-nums text-[var(--sera-ink)]">
                        {rm(row.amount)}
                      </p>
                      <p className="text-xs text-[var(--sera-muted)]">
                        {COMMISSION_STATUS_LABELS[row.status] || row.status}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-[var(--sera-muted)]">
                No orders yet.
              </p>
            )}
          </section>

          <section className="grid gap-3 lg:grid-cols-2">
            <div className={card}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold text-[var(--sera-ink)]">
                  Bank account
                </h2>
                {!editBank ? (
                  <button
                    type="button"
                    className="text-sm text-[var(--sera-orange)]"
                    onClick={() => setEditBank(true)}
                  >
                    Change
                  </button>
                ) : null}
              </div>
              {editBank ? (
                <>
                  <div className="mt-4">
                    <BankFields value={bank} onChange={setBank} />
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      type="button"
                      className="h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
                      disabled={busy}
                      onClick={() =>
                        post(
                          { action: "update_bank", ...bank },
                          "Bank details saved.",
                        )
                      }
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 rounded-xl"
                      onClick={() => {
                        setEditBank(false);
                        const isEwallet = MALAYSIAN_EWALLETS.some(
                          (e) => e.value === affiliate.bankName,
                        );
                        setBank({
                          bankType: isEwallet ? "ewallet" : "bank",
                          bankName: affiliate.bankName,
                          bankAccountNo: affiliate.bankAccountNo,
                          bankAccountName: affiliate.bankAccountName,
                        });
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-sm text-[var(--sera-ink)]">
                  {affiliate.bankName
                    ? `${affiliate.bankName} ${maskAccountNo(affiliate.bankAccountNo)} · ${affiliate.bankAccountName}`
                    : "Add the account that should receive your commission."}
                </p>
              )}
            </div>
            <div className={card}>
              <h2 className="text-base font-semibold text-[var(--sera-ink)]">
                Transfers
              </h2>
              <p className="mt-1 text-sm text-[var(--sera-muted)]">
                {program.minPayoutAmount > 0
                  ? `Sent once confirmed commission reaches ${rm(program.minPayoutAmount)}.`
                  : "Sent after commission is confirmed."}
              </p>
              {data.payouts && data.payouts.length > 0 ? (
                <ul className="mt-3 divide-y divide-[var(--sera-line)]">
                  {data.payouts.map((payout, index) => (
                    <li
                      key={`${payout.reference}-${index}`}
                      className="flex items-center justify-between gap-3 py-3 text-sm"
                    >
                      <span className="text-[var(--sera-muted)]">
                        {day(payout.paidAt)}
                        <span className="mt-0.5 block">
                          Ref {payout.reference} · {payout.count} order
                          {payout.count === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums text-[var(--sera-ink)]">
                        {rm(payout.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-[var(--sera-muted)]">
                  No transfers yet.
                </p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </Shell>
  );
}
