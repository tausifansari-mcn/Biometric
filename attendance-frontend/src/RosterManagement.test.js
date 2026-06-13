import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RosterManagement from './RosterManagement';

const shift = {
  id: 7,
  shift_name: 'General 9-7',
  start_time: '09:00',
  end_time: '19:00',
  grace_minutes: 15,
  break_minutes: 60,
  status: 'Active',
  is_overnight: false,
  productive_minutes: 540
};

const employee = {
  emp_code: 'MAS10001',
  name: 'Asha Singh',
  process_name: 'Operations',
  lob_name: 'Inbound',
  manager_name: 'Operations Manager'
};

beforeEach(() => {
  jest.restoreAllMocks();
  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/roster/shifts') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(shift)
      });
    }
    if (url.includes('/api/roster/assign') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          created_count: 1,
          updated_count: 0,
          roster_dates: 1,
          employee_count: 1
        })
      });
    }
    if (url.includes('/api/roster/shifts')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([shift])
      });
    }
    if (url.includes('/api/roster/employees')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([employee])
      });
    }
    if (url.includes('/api/roster?')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([])
      });
    }
    return Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ detail: 'Unexpected request' })
    });
  });
});

test('creates a 9-to-7 shift with grace and break settings', async () => {
  render(
    <RosterManagement
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      initialMonth="2026-06"
      canManageShifts
    />
  );

  expect(await screen.findByText('General 9-7')).toBeInTheDocument();
  expect(screen.getByLabelText('Start Time')).toHaveValue('09:00');
  expect(screen.getByLabelText('End Time')).toHaveValue('19:00');

  fireEvent.change(screen.getByLabelText('Shift Name'), {
    target: { value: 'Day Shift' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create Shift' }));

  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/api/roster/shifts',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        shift_name: 'Day Shift',
        start_time: '09:00',
        end_time: '19:00',
        grace_minutes: 15,
        break_minutes: 60,
        status: 'Active'
      })
    })
  ));
});

test('assigns selected employees to a working shift', async () => {
  render(
    <RosterManagement
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      initialMonth="2026-06"
      canManageShifts={false}
    />
  );

  await screen.findByText('Asha Singh');
  fireEvent.change(screen.getByLabelText('Employee Codes'), {
    target: { value: 'MAS10001' }
  });
  fireEvent.change(screen.getByLabelText('From Date'), {
    target: { value: '2026-06-15' }
  });
  fireEvent.change(screen.getByLabelText('To Date'), {
    target: { value: '2026-06-15' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Assign Roster' }));

  await waitFor(() => {
    const assignmentCall = global.fetch.mock.calls.find(
      ([url, options = {}]) => (
        url.endsWith('/api/roster/assign') && options.method === 'POST'
      )
    );
    expect(JSON.parse(assignmentCall[1].body)).toEqual(expect.objectContaining({
      emp_codes: ['MAS10001'],
      date_from: '2026-06-15',
      date_to: '2026-06-15',
      day_type: 'Working',
      shift_id: 7
    }));
  });
  expect(await screen.findByText(/1 employee\(s\) rostered/i)).toBeInTheDocument();
});
