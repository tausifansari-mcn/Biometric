import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReportDashboard from './ReportDashboard';

const metrics = {
  mandate: 12,
  working_days: 10,
  planned_agent_days: 120,
  present: 90,
  half_day: 10,
  absent: 20,
  on_time: 72,
  late: 28,
  adherence_percent: 79.2,
  shrinkage_percent: 20.8,
  on_time_percent: 72,
  late_percent: 28
};

const report = {
  scope_label: 'Overall organization',
  date_from: '2026-06-01',
  date_to: '2026-06-13',
  shift_start: '10:00',
  late_grace_minutes: 15,
  methodology: 'Mandate is active agent headcount.',
  overall: metrics,
  processes: [{
    name: 'Operations',
    metrics,
    lobs: [{
      name: 'Inbound',
      metrics: { ...metrics, mandate: 7 }
    }]
  }],
  agents: [{
    emp_code: 'MAS10001',
    name: 'Asha Singh',
    process_name: 'Operations',
    lob_name: 'Inbound',
    manager_name: 'Operations Manager',
    metrics
  }],
  agent_count: 1,
  daily_records: [{
    attendance_date: '2026-06-13',
    metrics
  }],
  process_options: ['Operations'],
  lob_options: ['Inbound']
};

beforeEach(() => {
  jest.restoreAllMocks();
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(report)
  }));
});

test('shows overall and process report slides with scoped workforce metrics', async () => {
  render(
    <ReportDashboard
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      initialMonth="2026-06"
    />
  );

  expect(await screen.findByText('Overall Workforce View')).toBeInTheDocument();
  expect(screen.getByText('Overall organization')).toBeInTheDocument();
  expect(screen.getAllByText('79.2%').length).toBeGreaterThan(0);
  expect(screen.getByText('Operations Manager')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '02 Operations' }));

  expect(screen.getByRole('heading', { name: 'Operations' })).toBeInTheDocument();
  expect(screen.getAllByText('Inbound').length).toBeGreaterThan(0);
  expect(screen.getByText('7')).toBeInTheDocument();
});

test('applies process and agent filters to the report request', async () => {
  render(
    <ReportDashboard
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      initialMonth="2026-06"
    />
  );

  await screen.findByText('Overall Workforce View');
  fireEvent.change(screen.getByLabelText('Process'), {
    target: { value: 'Operations' }
  });
  fireEvent.change(screen.getByLabelText('Agent'), {
    target: { value: 'MAS10001' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));

  await waitFor(() => expect(global.fetch).toHaveBeenLastCalledWith(
    expect.stringContaining('process_name=Operations'),
    expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' }
    })
  ));
  expect(global.fetch.mock.calls.at(-1)[0]).toContain('agent_search=MAS10001');
});
