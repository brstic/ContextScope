import { Link } from 'react-router-dom';
import { Panel } from '../components/ui/panel';

export default function NotFoundPage() {
  return (
    <Panel className="p-4">
      <h1 className="text-[16px] font-semibold">Page not found</h1>
      <p className="mt-1 text-muted">
        <Link to="/" className="text-fg underline">Back to the overview</Link>
      </p>
    </Panel>
  );
}
