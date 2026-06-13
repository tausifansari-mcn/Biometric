import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApplicationAccess from './ApplicationAccess';

beforeEach(() => {
  jest.restoreAllMocks();
});

test('loads application accounts and deactivates a user', async () => {
  let status = 'Active';
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  global.fetch = jest.fn((url, options = {}) => {
    if (options.method === 'PUT') {
      status = 'Inactive';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          emp_code: 'MAS10001',
          name: 'Test Employee',
          role: 'Employee',
          source: 'Employee',
          status
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        users: [{
          emp_code: 'MAS10001',
          name: 'Test Employee',
          role: 'Employee',
          source: 'Employee',
          status
        }],
        active_count: status === 'Active' ? 1 : 0,
        inactive_count: status === 'Inactive' ? 1 : 0,
        total_count: 1
      })
    });
  });

  render(
    <ApplicationAccess
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      currentEmpCode="MAS00001"
    />
  );

  expect(await screen.findByText('Test Employee')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

  expect(window.confirm).toHaveBeenCalledWith(
    'Deactivate application access for Test Employee?'
  );
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/application-access/MAS10001',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'Inactive' })
      })
    );
  });
  expect(await screen.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
});

test('does not allow the signed-in Super Admin to deactivate themselves', async () => {
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      users: [{
        emp_code: 'MAS00001',
        name: 'Super Admin',
        role: 'SuperAdmin',
        source: 'Employee',
        status: 'Active'
      }],
      active_count: 1,
      inactive_count: 0,
      total_count: 1
    })
  }));

  render(
    <ApplicationAccess
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      currentEmpCode="MAS00001"
    />
  );

  expect(await screen.findByText('Super Admin')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
});
