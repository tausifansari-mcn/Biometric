import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentReportScheduleModal from './AgentReportScheduleModal';

const schedules = [
  {
    id: 1, process_name: 'GNC', lob_name: null, attendance: 'present', report_day: 'yesterday',
    send_time: '09:00', email: 'rohan@teammas.in', status: 'Active',
    last_sent_at: null, last_sent_status: null
  }
];

const contacts = [
  { id: 1, process_name: 'GNC', contact_name: 'Rohan Kumar', email: 'rohan@teammas.in' }
];

const agentProcessOptions = {
  processes: ['GNC', 'Clovia'],
  lobs: [],
  lobsByProcess: {}
};

beforeEach(() => {
  jest.restoreAllMocks();
  global.fetch = jest.fn((url, options = {}) => {
    if (options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 2, process_name: 'Clovia', lob_name: null, attendance: 'present',
          report_day: 'yesterday', send_time: '10:00', email: 'ashima.kapila@teammas.in',
          status: 'Active', last_sent_at: null, last_sent_status: null
        })
      });
    }
    if (options.method === 'PUT' || options.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (String(url).includes('/api/process-contacts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(contacts) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(schedules) });
  });
});

test('lists existing schedules', async () => {
  render(
    <AgentReportScheduleModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  expect(await screen.findByText('rohan@teammas.in')).toBeInTheDocument();
  expect(screen.getAllByText('GNC').length).toBeGreaterThan(0);
  expect(screen.getByText('Active')).toBeInTheDocument();
});

test('auto-fills the email from the matching Process contact', async () => {
  render(
    <AgentReportScheduleModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  await screen.findByText('rohan@teammas.in');
  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'GNC' } });

  expect(screen.getByLabelText('Email(s)').value).toBe('rohan@teammas.in');
});

test('creates a new schedule', async () => {
  render(
    <AgentReportScheduleModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  await screen.findByText('rohan@teammas.in');
  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'Clovia' } });
  fireEvent.change(screen.getByLabelText('Email(s)'), { target: { value: 'ashima.kapila@teammas.in' } });
  fireEvent.change(screen.getByLabelText('Send Time'), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Schedule' }));

  await waitFor(() => expect(screen.getByText('Schedule created')).toBeInTheDocument());

  const postCall = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(postCall[0]).toBe('http://localhost:8000/api/agent-report/schedules');
  const body = JSON.parse(postCall[1].body);
  expect(body).toEqual(expect.objectContaining({
    process_name: 'Clovia', send_time: '10:00', email: 'ashima.kapila@teammas.in', status: 'Active',
    frequency: 'daily', report_day: 'yesterday', run_date: null
  }));
});

test('switching to One Time reveals a Date field and sends frequency/run_date', async () => {
  render(
    <AgentReportScheduleModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  await screen.findByText('rohan@teammas.in');
  expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'Clovia' } });
  fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'once' } });
  expect(screen.queryByLabelText('Report Day')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-01' } });
  fireEvent.change(screen.getByLabelText('Email(s)'), { target: { value: 'ashima.kapila@teammas.in' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Schedule' }));

  await waitFor(() => expect(screen.getByText('Schedule created')).toBeInTheDocument());

  const postCall = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  const body = JSON.parse(postCall[1].body);
  expect(body).toEqual(expect.objectContaining({
    frequency: 'once', run_date: '2026-08-01'
  }));
});

test('pauses an active schedule', async () => {
  render(
    <AgentReportScheduleModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  await screen.findByText('rohan@teammas.in');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

  await waitFor(() => (
    expect(global.fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true)
  ));

  const putCall = global.fetch.mock.calls.find(([, options]) => options?.method === 'PUT');
  expect(putCall[0]).toBe('http://localhost:8000/api/agent-report/schedules/1');
  expect(JSON.parse(putCall[1].body).status).toBe('Paused');
});
