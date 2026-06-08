import { render, screen } from '@testing-library/react';
import { ApprovalList } from '@/components/approvals/approval-list';
import type { Approval } from '@/lib/types';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }),
    },
  }),
}));

const approval: Approval = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  org_id: 'org',
  task_id: 'task',
  level: 2,
  action_type: 'browser.click',
  action_hash: 'a'.repeat(64),
  nonce: 'nonce',
  status: 'pending',
  payload: { selector: '#confirm' },
  summary: 'Confirm browser action',
  screenshot_ref: 'shot-1',
  source: 'browser',
  requested_by: 'user',
  reviewed_by: null,
  reviewed_by_2: null,
  reviewed_at: null,
  nonce_used_at: null,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  created_at: new Date().toISOString(),
};

describe('ApprovalList', () => {
  it('renders pending approval with actions and screenshot', () => {
    render(
      <ApprovalList
        initialApprovals={[approval]}
        screenshots={{ 'shot-1': { id: 'shot-1', image_base64: 'cG5n', mime_type: 'image/png' } }}
      />,
    );

    expect(screen.getByText('browser.click')).toBeInTheDocument();
    expect(screen.getByText('Confirm browser action')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
    expect(screen.getByAltText('Approval screenshot')).toBeInTheDocument();
  });
});
