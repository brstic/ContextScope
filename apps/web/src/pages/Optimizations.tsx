import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FindingList } from '../components/Findings';
import { PageHeader } from '../components/Layout';
import { ErrorState, LoadingBlock } from '../components/States';
import { Panel, PanelHeader } from '../components/ui/panel';
import { Select } from '../components/ui/select';
import { api } from '../lib/api';
import { findingTypeLabel } from '../lib/format';

const TYPES = ['duplicate_system_instructions', 'oversized_tool_schemas', 'unstable_prefix', 'repeated_retrieval_payload', 'history_duplication', 'low_cache_reuse', 'excessive_context_growth', 'repeated_large_input', 'expensive_model_usage', 'token_spike', 'unexpected_cache_writes', 'slow_request', 'repeated_structured_schema', 'large_tool_output', 'duplicate_segment'];

export default function OptimizationsPage() {
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const q = useQuery({ queryKey: ['optimizations', { severity, type }], queryFn: ({ signal }) => api.optimizations({ severity: severity || undefined, type: type || undefined }, signal) });
  return (
    <div className="space-y-3">
      <PageHeader
        title="Optimizations"
        description="Findings from the analyzer. Token reductions are estimates; each finding states its trade-off."
        actions={<>
          <Select label="Severity" anyLabel="All severities" value={severity} onValueChange={setSeverity} options={['high', 'medium', 'low', 'info'].map((s) => ({ value: s, label: s }))} className="w-36" />
          <Select label="Type" anyLabel="All types" value={type} onValueChange={setType} options={TYPES.map((t) => ({ value: t, label: findingTypeLabel(t) }))} className="w-52" />
        </>}
      />
      <Panel>
        <PanelHeader title={q.data ? `${q.data.length} findings` : 'Findings'} />
        {q.isPending ? <LoadingBlock rows={6} /> : q.isError ? <div className="p-3"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : <FindingList findings={q.data} empty={severity || type ? 'No findings match these filters.' : 'No findings yet. They appear as requests are captured and analysed.'} />}
      </Panel>
    </div>
  );
}
