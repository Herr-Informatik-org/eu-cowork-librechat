import { Link } from 'react-router-dom';
import { useLocalize } from '~/hooks';

export default function OpsPersonalSettings() {
  const localize = useLocalize();
  return (
    <Link to="/ops-connect" className="underline">
      {localize('com_ui_ops_personal_title')}
    </Link>
  );
}
