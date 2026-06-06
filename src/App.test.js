import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App, { buildSummary } from './App';

jest.mock('react-calendar', () => (props) => (
  <div data-testid="calendar">
    {props.tileContent?.({ date: new Date(2026, 5, 4), view: 'month' })}
  </div>
));

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

test('renders the login logo and form', () => {
  render(<App />);
  expect(screen.getByRole('img', { name: /mas logo/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
});

test('does not count Sundays, holidays, or future dates as absent', () => {
  const attendance = {
    '2026-06-01': { WorkingMinutes: 600 },
    '2026-06-02': { WorkingMinutes: 300 },
    '2026-06-03': { WorkingMinutes: 120 }
  };
  const holidays = {
    '2026-06-04': { reason: 'Holiday' }
  };

  expect(buildSummary(
    2026,
    6,
    attendance,
    holidays,
    new Date(2026, 5, 8, 23, 59, 59)
  )).toEqual({
    present: 1,
    halfDay: 1,
    absent: 4
  });
});

test('keeps calendar visible and restores employee details when profile API fails', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDM1OCIsInJvbGUiOiJVc2VyIn0.signature');
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/attendance')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          UserID: 'MAS60358',
          Name: 'Test Employee',
          Designation: 'Software Engineer',
          Role: 'Employee',
          AttendanceDate: '2026-06-01',
          WorkingMinutes: 600
        }])
      });
    }
    if (url.includes('/api/holidays')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([])
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({})
    });
  });

  render(<App />);

  await waitFor(() => {
    expect(screen.getByText('Test Employee')).toBeInTheDocument();
  });
  expect(screen.getByTestId('calendar')).toBeInTheDocument();
  expect(screen.queryByText('Failed to load profile')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(screen.getByText('Software Engineer')).toBeInTheDocument();
});

test('keeps Designation separate from Role when stale cache had the role in both fields', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDM1OCIsInJvbGUiOiJBZG1pbiJ9.signature');
  localStorage.setItem('attendanceProfile', JSON.stringify({
    name: 'Tausif Ansari',
    emp_code: 'MAS60358',
    designation: 'Admin',
    role: 'Admin'
  }));
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/attendance')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          UserID: 'MAS60358',
          Name: 'Tausif Ansari',
          Designation: 'Data Analyst',
          Role: 'Admin',
          AttendanceDate: '2026-06-01',
          WorkingMinutes: 600
        }])
      });
    }
    if (url.includes('/api/holidays')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  await screen.findByText('Tausif Ansari');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));

  expect(screen.getByText('Data Analyst')).toBeInTheDocument();
  expect(screen.getByText('Admin')).toBeInTheDocument();
});

test('closes the profile popup when clicking outside it', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDM1OCIsInJvbGUiOiJVc2VyIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Test Employee',
    emp_code: 'MAS60358',
    designation: 'Software Engineer',
    role: 'User'
  }));
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Test Employee',
          emp_code: 'MAS60358',
          designation: 'Software Engineer',
          role: 'Employee'
        })
      });
    }
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([])
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({})
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(await screen.findByText('Software Engineer')).toBeInTheDocument();

  fireEvent.mouseDown(document.body);
  await waitFor(() => {
    expect(screen.queryByText('Software Engineer')).not.toBeInTheDocument();
  });
});

test('shows the admin employee form and submits an Employee role', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJBZG1pbiJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Admin User',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'Admin'
  }));
  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/employees')) {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({
          id: 10,
          emp_name: 'New Employee',
          designation: 'Engineer',
          role: 'Employee',
          emp_code: 'MAS10001'
        })
      });
    }
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([])
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({})
    });
  });

  render(<App />);
  expect(screen.getByText('Biometric Attendance')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage Employees' }));

  fireEvent.change(screen.getByLabelText('Employee Name'), { target: { value: 'New Employee' } });
  fireEvent.change(screen.getByLabelText('Designation'), { target: { value: 'Engineer' } });
  fireEvent.change(screen.getByLabelText('Employee Code'), { target: { value: 'mas10001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Employee' }));

  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('MAS10001');
  });
  expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/api/employees',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        emp_name: 'New Employee',
        designation: 'Engineer',
        role: 'Employee',
        emp_code: 'MAS10001'
      })
    })
  );
});

test('shows attendance details when the employee punches on a holiday', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDM1OCIsInJvbGUiOiJFbXBsb3llZSJ9.signature');
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/attendance')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          UserID: 'MAS60358',
          Name: 'Test Employee',
          Designation: 'Software Engineer',
          Role: 'Employee',
          AttendanceDate: '2026-06-04',
          FirstPunchIn: '2026-06-04T09:00:00',
          LastPunchOut: '2026-06-04T18:30:00',
          TotalPunches: 4,
          WorkingMinutes: 570,
          WorkingHours: '9:30'
        }])
      });
    }
    if (url.includes('/api/holidays')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          id: 7,
          holiday_date: '2026-06-04',
          reason: 'Founders Day'
        }])
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({})
    });
  });

  render(<App />);

  const calendar = await screen.findByTestId('calendar');
  await waitFor(() => {
    expect(within(calendar).getByText('Holiday: Founders Day')).toBeInTheDocument();
  });
  expect(within(calendar).getByText('Punch In')).toBeInTheDocument();
  expect(within(calendar).getByText('Punch Out')).toBeInTheDocument();
  expect(within(calendar).getByText('Attempts / Punches')).toBeInTheDocument();
  expect(within(calendar).getAllByText('4')).toHaveLength(2);
  expect(within(calendar).getByText('Login Hours')).toBeInTheDocument();
  expect(within(calendar).getByText('9:30')).toBeInTheDocument();
  expect(within(calendar).getByText('Present')).toBeInTheDocument();
});

test('admin can edit holidays and EmployeeDetails rows', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJBZG1pbiJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Admin User',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'Admin'
  }));

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/attendance')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/holidays/7') && options.method === 'PUT') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 7,
          holiday_date: '2026-06-05',
          reason: 'Updated Holiday'
        })
      });
    }
    if (url.includes('/api/holidays')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          id: 7,
          holiday_date: '2026-06-04',
          reason: 'Founders Day'
        }])
      });
    }
    if (url.includes('/api/employees/3') && options.method === 'PUT') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 3,
          emp_name: 'Existing Employee',
          designation: 'Senior Engineer',
          role: 'Employee',
          emp_code: 'MAS10003'
        })
      });
    }
    if (url.includes('/api/employees')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          id: 3,
          emp_name: 'Existing Employee',
          designation: 'Engineer',
          role: 'Employee',
          emp_code: 'MAS10003'
        }])
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Holiday' }));

  await screen.findByText('2026-06-04 - Founders Day');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Founders Day' }));
  fireEvent.change(screen.getByDisplayValue('Founders Day'), {
    target: { value: 'Updated Holiday' }
  });
  fireEvent.change(screen.getByDisplayValue('2026-06-04'), {
    target: { value: '2026-06-05' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update Holiday' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/holidays/7',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          holiday_date: '2026-06-05',
          reason: 'Updated Holiday'
        })
      })
    );
  });

  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage Employees' }));
  await screen.findByText('Existing Employee');
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByDisplayValue('Engineer'), {
    target: { value: 'Senior Engineer' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update Employee' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/employees/3',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          emp_name: 'Existing Employee',
          designation: 'Senior Engineer',
          role: 'Employee',
          emp_code: 'MAS10003'
        })
      })
    );
  });
});
