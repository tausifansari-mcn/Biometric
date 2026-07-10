import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentReport from './AgentReport';

const report = {
  date: '2026-07-10',
  process_options: ['Bellavita'],
  lob_options: ['Repeat'],
  agents: [{
    emp_code: 'MAS123',
    name: 'Test Kumar',
    process_name: 'Bellavita',
    lob_name: 'Repeat',
    punch_in: '09:58',
    punch_out: '18:42',
    total_hours: '08:44',
    present: true
  }],
  overall: { total_agents: 1, present: 1, absent: 0, avg_hours: '08:44' },
  by_lob: [{ lob_name: 'Repeat', total_agents: 1, present: 1, absent: 0, avg_hours: '08:44' }]
};

const agentProcessOptions = {
  processes: ['Bellavita'],
  lobs: ['Repeat'],
  lobsByProcess: { Bellavita: ['Repeat'] }
};

beforeEach(() => {
  jest.restoreAllMocks();
  global.fetch = jest.fn((url, options = {}) => {
    if (options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sent: true, email: 'manager@company.com' })
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(report)
    });
  });
});

test('shows agent-wise punch in/out/total hours for the selected date', async () => {
  render(
    <AgentReport
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
    />
  );

  expect(await screen.findByText('Test Kumar')).toBeInTheDocument();
  expect(screen.getByText('09:58')).toBeInTheDocument();
  expect(screen.getByText('18:42')).toBeInTheDocument();
  expect(screen.getAllByText('08:44').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Total Agents').length).toBeGreaterThan(0);
  expect(screen.getAllByText('1').length).toBeGreaterThan(0);
  expect(screen.getByText('LOB-wise Summary')).toBeInTheDocument();
});

test('applies date/process/lob filters to the report request', async () => {
  render(
    <AgentReport
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
    />
  );

  await screen.findByText('Test Kumar');
  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'Bellavita' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-07-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));

  await waitFor(() => expect(global.fetch).toHaveBeenLastCalledWith(
    expect.stringContaining('date=2026-07-01'),
    expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' }
    })
  ));
  expect(global.fetch.mock.calls.at(-1)[0]).toContain('process_name=Bellavita');
});

test('sends the report by email from the Send Report popup', async () => {
  render(
    <AgentReport
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
    />
  );

  await screen.findByText('Test Kumar');
  fireEvent.click(screen.getByRole('button', { name: 'Send Report' }));

  fireEvent.change(screen.getByLabelText('Manager Email'), {
    target: { value: 'manager@company.com' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => (
    expect(screen.getByText('Report sent to manager@company.com')).toBeInTheDocument()
  ));

  const postCall = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(postCall[0]).toBe('http://localhost:8000/api/reports/agent-report/email');
  expect(JSON.parse(postCall[1].body)).toEqual(
    expect.objectContaining({ email: 'manager@company.com' })
  );
});

test('rejects an invalid email address without calling the API', async () => {
  render(
    <AgentReport
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
    />
  );

  await screen.findByText('Test Kumar');
  fireEvent.click(screen.getByRole('button', { name: 'Send Report' }));

  fireEvent.change(screen.getByLabelText('Manager Email'), {
    target: { value: 'not-an-email' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
  expect(global.fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
