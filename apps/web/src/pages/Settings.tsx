import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/Layout';
import { ErrorState, LoadingBlock } from '../components/States';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Switch } from '../components/ui/switch';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api, ApiError, type SettingsUpdate } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useTheme } from '../lib/theme';

const MODES = [
  { value: 'metadata', label: 'Metadata only', desc: 'Sizes, fingerprints, usage and cost. No prompt or response content is kept.' },
  { value: 'deep_memory', label: 'Deep (memory)', desc: 'Content kept in a bounded in-memory buffer; gone on restart.' },
  { value: 'deep_persistent', label: 'Deep (persistent)', desc: 'Content stored encrypted in the local database until retention expires.' },
];

const CopyBtn = ({ text }: { text: string }) => {
  const [ok, setOk] = useState(false);
  return (
    <Button size="iconSm" variant="ghost" aria-label={`Copy ${text}`} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); }}>
      {ok ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
};

export default function SettingsPage() {
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const s = useQuery({ queryKey: ['settings'], queryFn: ({ signal }) => api.settings(signal) });
  const providers = useQuery({ queryKey: ['providers'], queryFn: ({ signal }) => api.providers(signal) });
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const [retH, setRetH] = useState('');
  const [retD, setRetD] = useState('');
  const [overrides, setOverrides] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!s.data) return;
    setRetH(String(s.data.contentRetentionHours));
    setRetD(String(s.data.metadataRetentionDays));
    setOverrides(JSON.stringify(s.data.pricingOverrides, null, 2));
  }, [s.data]);
  const save = useMutation({
    mutationFn: (body: SettingsUpdate) => api.updateSettings(body),
    onSuccess: (data) => { qc.setQueryData(['settings'], data); setErr(null); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save settings'),
  });

  if (s.isPending) return <LoadingBlock rows={8} />;
  if (s.isError) return <ErrorState error={s.error} onRetry={() => void s.refetch()} />;
  const d = s.data;
  // The dashboard is served by the ContextScope server itself, so the proxy shares its origin.
  const base = window.location.origin;

  const chooseMode = (m: string) => (m === 'metadata' ? save.mutate({ captureMode: m }) : setPendingMode(m));
  const saveRetention = () => save.mutate({ contentRetentionHours: Number(retH), metadataRetentionDays: Number(retD) });
  const saveOverrides = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(overrides || '[]'); } catch (e) { setErr(`Invalid JSON: ${(e as Error).message}`); return; }
    if (!Array.isArray(parsed)) { setErr('Pricing overrides must be a JSON array of model prices.'); return; }
    save.mutate({ pricingOverrides: parsed });
  };
  const input = 'num h-8 w-28 rounded-[4px] border border-border bg-bg px-2 text-[13px]';

  return (
    <div className="space-y-3">
      <PageHeader title="Settings" />
      {err ? <div role="alert" className="rounded-[6px] border border-error/40 bg-error/5 p-2 text-[12px] text-error">{err}</div> : null}
      <Panel>
        <PanelHeader title="Capture mode" description="Applies to new requests" />
        <PanelBody>
          <fieldset className="space-y-2">
            <legend className="sr-only">Capture mode</legend>
            {MODES.map((m) => (
              <label key={m.value} className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="mode" className="mt-1 accent-[var(--text)]" checked={d.captureMode === m.value} onChange={() => chooseMode(m.value)} />
                <span><span className="font-medium">{m.label}</span><span className="block text-[12px] text-muted">{m.desc}</span></span>
              </label>
            ))}
          </fieldset>
        </PanelBody>
      </Panel>
      <Dialog open={pendingMode !== null} onOpenChange={(o) => !o && setPendingMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Store prompt and response content?</DialogTitle>
            <DialogDescription>Deep capture keeps full request and response bodies: prompts, documents, tool outputs and anything personal or confidential in them. API keys are never stored. Content is deleted after the retention window.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setPendingMode(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { if (pendingMode) save.mutate({ captureMode: pendingMode }); setPendingMode(null); }}>Enable deep capture</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Panel>
        <PanelHeader title="Retention" />
        <PanelBody className="flex flex-wrap items-end gap-4">
          <label className="text-[12px] text-muted">Content retention (hours)<input type="number" min={1} className={`${input} mt-1 block`} value={retH} onChange={(e) => setRetH(e.target.value)} /></label>
          <label className="text-[12px] text-muted">Metadata retention (days, 0 = forever)<input type="number" min={0} className={`${input} mt-1 block`} value={retD} onChange={(e) => setRetD(e.target.value)} /></label>
          <Button onClick={saveRetention} disabled={save.isPending}>Save retention</Button>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Pricing overrides" description={<>JSON array of model prices (micro-USD per 1M tokens). Active pricing <span className="num">{d.pricingVersion}</span></>} />
        <PanelBody className="space-y-2">
          <label htmlFor="overrides" className="sr-only">Pricing overrides JSON</label>
          <textarea id="overrides" spellCheck={false} rows={8} value={overrides} onChange={(e) => setOverrides(e.target.value)} className="num w-full rounded-[4px] border border-border bg-bg p-2 text-[12px]" />
          <Button onClick={saveOverrides} disabled={save.isPending}>Save overrides</Button>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Provider routes" description="Use these as the base URL in your SDK" />
        {providers.isPending ? <LoadingBlock rows={3} /> : providers.isError ? <div className="p-3"><ErrorState error={providers.error} onRetry={() => void providers.refetch()} /></div> : (
          <Table>
            <THead><Tr><Th>Route</Th><Th>Protocol</Th><Th>Base URL</Th><Th>Upstream</Th></Tr></THead>
            <TBody>{providers.data.map((p) => { const url = `${base}${p.routePrefix}${p.protocol === 'openai' ? '/v1' : ''}`; return (<Tr key={p.id}><Td>{p.id}{p.custom ? <span className="ml-1 text-muted">(custom)</span> : null}</Td><Td>{p.protocol}</Td><Td><span className="num">{url}</span><CopyBtn text={url} /></Td><Td className="num text-muted">{p.upstream}</Td></Tr>); })}</TBody>
          </Table>
        )}
      </Panel>
      <Panel>
        <PanelHeader title="Storage" />
        <PanelBody className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
          <div><div className="text-muted">Stored requests</div><div className="num text-[16px]">{d.stats.storedRequests.toLocaleString('en-US')}</div></div>
          <div><div className="text-muted">Queue depth</div><div className="num text-[16px]">{d.stats.queueDepth}</div></div>
          <div><div className="text-muted">Dropped events</div><div className={`num text-[16px] ${d.stats.droppedEvents ? 'text-error' : ''}`}>{d.stats.droppedEvents}</div></div>
          <div><div className="text-muted">Database size</div><div className="num text-[16px]">{formatBytes(d.stats.dbBytes)}</div></div>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Appearance" />
        <PanelBody><label className="flex items-center gap-2"><Switch checked={theme === 'dark'} onCheckedChange={(c) => setTheme(c ? 'dark' : 'light')} aria-label="Dark theme" /> Dark theme</label></PanelBody>
      </Panel>
    </div>
  );
}
