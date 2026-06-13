import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App, { buildSummary, getCalendarTileClassName } from './App';

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
  expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument();
});

test('sends a password reset request to the assigned manager', async () => {
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      message: 'Password reset request sent to Assigned Manager. You can use the new password after approval.'
    })
  }));

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));
  fireEvent.change(screen.getByLabelText('Employee Code'), {
    target: { value: 'mas60358' }
  });
  fireEvent.change(screen.getByLabelText('New Password'), {
    target: { value: 'NewSecure123' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send Reset Request' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/forgot-password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          emp_code: 'MAS60358',
          password: 'NewSecure123'
        })
      })
    );
  });
  expect(await screen.findByText(/request sent to assigned manager/i)).toBeInTheDocument();
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

test('positions tooltips by actual weekday for every calendar month', () => {
  expect(getCalendarTileClassName({
    date: new Date(2026, 4, 1),
    view: 'month'
  })).toBe('calendar-column-5 calendar-tooltip-below');
  expect(getCalendarTileClassName({
    date: new Date(2026, 4, 2),
    view: 'month'
  })).toBe('calendar-column-6 calendar-tooltip-below');
  expect(getCalendarTileClassName({
    date: new Date(2026, 4, 8),
    view: 'month'
  })).toBe('calendar-column-5');
  expect(getCalendarTileClassName({
    date: new Date(2026, 5, 6),
    view: 'month'
  })).toBe('calendar-column-6 calendar-tooltip-below');
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

test('refreshes attendance every five seconds without hiding the calendar', async () => {
  jest.useFakeTimers();
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDM1OCIsInJvbGUiOiJFbXBsb3llZSJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Test Employee',
    emp_code: 'MAS60358',
    designation: 'Software Engineer',
    role: 'Employee'
  }));

  let attendanceRequestCount = 0;
  let resolveBackgroundRefresh;
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/attendance')) {
      attendanceRequestCount += 1;
      if (attendanceRequestCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([])
        });
      }
      return new Promise((resolve) => {
        resolveBackgroundRefresh = resolve;
      });
    }
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Test Employee',
          emp_code: 'MAS60358',
          designation: 'Software Engineer',
          role: 'Employee',
          is_manager: false
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  expect(await screen.findByTestId('calendar')).toBeInTheDocument();

  await act(async () => {
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
  });

  expect(attendanceRequestCount).toBe(2);
  expect(screen.getByTestId('calendar')).toBeInTheDocument();
  expect(screen.queryByText('Loading...')).not.toBeInTheDocument();

  await act(async () => {
    resolveBackgroundRefresh({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
    await Promise.resolve();
  });
  jest.useRealTimers();
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

test('profile shows Process and LOB only when AgentProcess matches the EmpCode', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDM1OCIsInJvbGUiOiJFbXBsb3llZSJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Test Employee',
    emp_code: 'MAS60358',
    designation: 'Software Engineer',
    role: 'Employee'
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
          role: 'Employee',
          is_manager: false,
          process_name: 'Customer Support',
          lob_name: 'Domestic Voice'
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));

  expect(await screen.findByText('Customer Support')).toBeInTheDocument();
  expect(screen.getByText('Domestic Voice')).toBeInTheDocument();
  expect(screen.getByText('Process')).toBeInTheDocument();
  expect(screen.getByText('LOB')).toBeInTheDocument();
});

test('shows the superadmin employee form and submits an Employee role', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
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
          emp_code: 'MAS10001',
          process_name: 'Customer Support',
          lob_name: 'Inbound',
          status: 'Active'
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
  fireEvent.click(screen.getByRole('button', { name: 'Manage Employee' }));

  fireEvent.change(screen.getByLabelText('Employee Name'), { target: { value: 'New Employee' } });
  fireEvent.change(screen.getByLabelText('Designation'), { target: { value: 'Engineer' } });
  fireEvent.change(screen.getByLabelText('Employee Code'), { target: { value: 'mas10001' } });
  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'Customer Support' } });
  fireEvent.change(screen.getByLabelText('LOBName'), { target: { value: 'Inbound' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Employee' }));

  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('MAS10001');
  });
  expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/api/employees',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        emp_code: 'MAS10001',
        emp_name: 'New Employee',
        designation: 'Engineer',
        role: 'Employee',
        process_name: 'Customer Support',
        lob_name: 'Inbound',
        status: 'Active'
      })
    })
  );
});

test('superadmin can paste and add multiple employees in one batch', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  global.fetch = jest.fn((url, options = {}) => {
    if (url.endsWith('/api/employees/bulk') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ created_count: 2, employees: [] })
      });
    }
    if (url.endsWith('/api/employees')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage Employee' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Bulk Employees' }));
  fireEvent.change(screen.getByLabelText('Bulk Employee Rows'), {
    target: {
      value: [
        'MAS10101, Riya Sharma, , Employee, Sales, Inbound, Active',
        'MAS10102, Aman Verma, Executive, Admin, Support, Chat, Inactive'
      ].join('\n')
    }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Bulk Employees' }));

  expect(await screen.findByRole('status')).toHaveTextContent('2 employee(s) added successfully.');
  expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/api/employees/bulk',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        employees: [{
          emp_code: 'MAS10101',
          emp_name: 'Riya Sharma',
          designation: 'Executive',
          role: 'Employee',
          process_name: 'Sales',
          lob_name: 'Inbound',
          status: 'Active'
        }, {
          emp_code: 'MAS10102',
          emp_name: 'Aman Verma',
          designation: 'Executive',
          role: 'Admin',
          process_name: 'Support',
          lob_name: 'Chat',
          status: 'Inactive'
        }]
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

test('superadmin can edit holidays and EmployeeDetails rows', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
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
          emp_code: 'MAS10003',
          process_name: 'Operations',
          lob_name: 'Voice',
          status: 'Active'
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
          emp_code: 'MAS10003',
          process_name: 'Operations',
          lob_name: 'Voice',
          status: 'Active'
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
  fireEvent.click(screen.getByRole('button', { name: 'Manage Employee' }));
  fireEvent.change(screen.getByLabelText('Search by Name'), {
    target: { value: 'Existing Employee' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
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
          emp_code: 'MAS10003',
          emp_name: 'Existing Employee',
          designation: 'Senior Engineer',
          role: 'Employee',
          process_name: 'Operations',
          lob_name: 'Voice',
          status: 'Active'
        })
      })
    );
  });
});

test('employee can open support and send a query to the assigned manager', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMxMDAwMSIsInJvbGUiOiJFbXBsb3llZSJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Employee User',
    emp_code: 'MAS10001',
    designation: 'Engineer',
    role: 'Employee'
  }));

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Employee User',
          emp_code: 'MAS10001',
          designation: 'Engineer',
          role: 'Employee',
          is_manager: false
        })
      });
    }
    if (url.endsWith('/api/support-queries') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({
          id: 15,
          employee_emp_code: 'MAS10001',
          employee_name: 'Employee User',
          manager_emp_code: 'MAS20001',
          manager_name: 'Assigned Manager',
          query_subject: 'Attendance correction',
          query_text: 'Please help with my attendance.',
          status: 'Open',
          image_name: null,
          has_image: false,
          created_at: '2026-06-09T10:00:00',
          solved_at: null,
          solved_by: null
        })
      });
    }
    if (url.endsWith('/api/support-queries')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Support' }));
  fireEvent.change(screen.getByLabelText('Query Subject'), {
    target: { value: 'Attendance correction' }
  });
  fireEvent.change(screen.getByLabelText('Query'), {
    target: { value: 'Please help with my attendance.' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Manager' }));

  expect(await screen.findByText('Query sent to Assigned Manager.')).toBeInTheDocument();
  const postCall = global.fetch.mock.calls.find(([, options = {}]) => options.method === 'POST');
  expect(postCall[0]).toBe('http://localhost:8000/api/support-queries');
  expect(postCall[1].body.get('query_subject')).toBe('Attendance correction');
  expect(postCall[1].body.get('query_text')).toBe('Please help with my attendance.');
});

test('manager can open the query bucket and mark an employee query solved', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDAwMSIsInJvbGUiOiJNYW5hZ2VyIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Manager User',
    emp_code: 'MAS60001',
    designation: 'Operations',
    role: 'Manager',
    is_manager: true
  }));

  const openQuery = {
    id: 20,
    employee_emp_code: 'MAS10001',
    employee_name: 'Employee User',
    manager_emp_code: 'MAS60001',
    manager_name: 'Manager User',
    query_subject: 'Missing punch',
    query_text: 'Please check my missing punch.',
    status: 'Open',
    image_name: null,
    has_image: false,
    created_at: '2026-06-09T10:00:00',
    solved_at: null,
    solved_by: null
  };

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Manager User',
          emp_code: 'MAS60001',
          designation: 'Operations',
          role: 'Manager',
          is_manager: true
        })
      });
    }
    if (url.endsWith('/api/manager/support-queries')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([openQuery]) });
    }
    if (url.includes('/api/manager/support-queries/20/solve') && options.method === 'PATCH') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ...openQuery,
          status: 'Solved',
          solved_at: '2026-06-09T11:00:00',
          solved_by: 'MAS60001'
        })
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Query Bucket' }));
  expect(await screen.findByText('Please check my missing punch.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Mark Solved' }));

  expect(await screen.findByText('Query marked as solved.')).toBeInTheDocument();
  expect(screen.getByText('Solved')).toBeInTheDocument();
});

test('manager profile shows notification counts for queries and password resets', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDAwMSIsInJvbGUiOiJNYW5hZ2VyIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Manager User',
    emp_code: 'MAS60001',
    designation: 'Operations',
    role: 'Manager',
    is_manager: true
  }));

  const openQueries = [
    {
      id: 20,
      employee_emp_code: 'MAS10020',
      employee_name: 'Employee 20',
      manager_emp_code: 'MAS60001',
      manager_name: 'Manager User',
      query_subject: 'Missing punch',
      query_text: 'Query 20',
      status: 'Open',
      image_name: null,
      has_image: false,
      created_at: '2026-06-13T10:00:00',
      solved_at: null,
      solved_by: null
    },
    {
      id: 21,
      employee_emp_code: 'MAS10021',
      employee_name: 'Employee 21',
      manager_emp_code: 'MAS60001',
      manager_name: 'Manager User',
      query_subject: 'Leave balance',
      query_text: 'Query 21',
      status: 'Open',
      image_name: null,
      has_image: false,
      created_at: '2026-06-13T10:00:00',
      solved_at: null,
      solved_by: null
    }
  ];
  const pendingReset = {
    id: 41,
    employee_emp_code: 'MAS10001',
    employee_name: 'Employee User',
    manager_emp_code: 'MAS60001',
    manager_name: 'Manager User',
    status: 'Pending',
    created_at: '2026-06-13T10:00:00',
    reviewed_at: null,
    reviewed_by: null
  };

  global.fetch = jest.fn((url) => {
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Manager User',
          emp_code: 'MAS60001',
          designation: 'Operations',
          role: 'Manager',
          is_manager: true
        })
      });
    }
    if (url.endsWith('/api/manager/support-queries')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(openQueries) });
    }
    if (url.endsWith('/api/manager/password-reset-requests')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([pendingReset])
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  await screen.findByTestId('calendar');

  const profileButton = screen.getByRole('button', { name: 'Open profile' });
  await waitFor(() => {
    expect(profileButton).toHaveAttribute('data-notification-count', '3');
  });
  expect(within(profileButton).getByText('3')).toHaveClass('profile-notification-badge');

  await act(async () => {
    fireEvent.click(profileButton);
    await Promise.resolve();
    await Promise.resolve();
  });
  const queryButton = screen.getByRole('button', { name: 'Query Bucket' });
  const resetButton = screen.getByRole('button', { name: 'Reset Password Requests' });
  expect(within(queryButton).getByText('2')).toHaveClass('task-notification-badge');
  expect(within(resetButton).getByText('1')).toHaveClass('task-notification-badge');

  await act(async () => {
    fireEvent.click(queryButton);
    await Promise.resolve();
    await Promise.resolve();
  });
  const taskNav = screen.getByRole('complementary', { name: 'Profile tasks' });
  expect(
    within(within(taskNav).getByRole('button', { name: 'Query Bucket' })).getByText('2')
  ).toHaveClass('task-notification-badge');
  expect(
    within(
      within(taskNav).getByRole('button', { name: 'Reset Password Requests' })
    ).getByText('1')
  ).toHaveClass('task-notification-badge');

  fireEvent.change(screen.getByLabelText('Search by Subject'), {
    target: { value: 'leave' }
  });
  expect(screen.getByText('Leave balance')).toBeInTheDocument();
  expect(screen.queryByText('Missing punch')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Search by Subject'), {
    target: { value: '' }
  });
  fireEvent.change(screen.getByLabelText('Search by Emp ID'), {
    target: { value: 'mas10020' }
  });
  expect(screen.getByText('Missing punch')).toBeInTheDocument();
  expect(screen.queryByText('Leave balance')).not.toBeInTheDocument();
});

test('manager can approve an assigned employee password reset request', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVM2MDAwMSIsInJvbGUiOiJNYW5hZ2VyIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Manager User',
    emp_code: 'MAS60001',
    designation: 'Operations',
    role: 'Manager',
    is_manager: true
  }));

  const pendingRequest = {
    id: 41,
    employee_emp_code: 'MAS10001',
    employee_name: 'Employee User',
    manager_emp_code: 'MAS60001',
    manager_name: 'Manager User',
    status: 'Pending',
    created_at: '2026-06-11T10:00:00',
    reviewed_at: null,
    reviewed_by: null
  };
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/attendance') || url.includes('/api/holidays')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Manager User',
          emp_code: 'MAS60001',
          designation: 'Operations',
          role: 'Manager',
          is_manager: true
        })
      });
    }
    if (url.endsWith('/api/manager/password-reset-requests')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([pendingRequest])
      });
    }
    if (
      url.endsWith('/api/manager/password-reset-requests/41/approve')
      && options.method === 'PATCH'
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ...pendingRequest,
          status: 'Approved',
          reviewed_at: '2026-06-11T10:30:00',
          reviewed_by: 'MAS60001'
        })
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset Password Requests' }));

  expect(await screen.findByText('Employee User (MAS10001)')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/manager/password-reset-requests/41/approve',
      expect.objectContaining({ method: 'PATCH' })
    );
  });
  expect(await screen.findByText(/password reset approved/i)).toBeInTheDocument();
  expect(screen.getByText('Approved')).toBeInTheDocument();
});

test('employee profile shows Support only', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMxMDAwMSIsInJvbGUiOiJFbXBsb3llZSJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Employee User',
    emp_code: 'MAS10001',
    designation: 'Engineer',
    role: 'Employee'
  }));

  global.fetch = jest.fn((url) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          name: 'Employee User',
          emp_code: 'MAS10001',
          designation: 'Engineer',
          role: 'Employee',
          is_manager: false
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));

  expect(screen.queryByRole('button', { name: 'Manage Employee' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add Manager' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Query Bucket' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add Holiday' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Support' })).toBeInTheDocument();
  expect(screen.queryByText('Process')).not.toBeInTheDocument();
  expect(screen.queryByText('LOB')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Support' }));
  const taskNav = screen.getByRole('complementary', { name: 'Profile tasks' });
  expect(screen.getByText('Biometric Attendance').closest('.dashboard')).toHaveClass('admin-page-open');
  expect(await screen.findByRole('heading', { name: 'Ask Your Manager' })).toBeInTheDocument();
  expect(within(taskNav).queryByRole('button', { name: /query bucket/i })).not.toBeInTheDocument();

  fireEvent.click(within(taskNav).getByRole('button', { name: 'Back to Attendance' }));
  expect(screen.getByTestId('calendar')).toBeInTheDocument();
});

test('admin profile shows Query Bucket, Add Holiday, and Support', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMiIsInJvbGUiOiJBZG1pbiJ9.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Admin User',
    emp_code: 'MAS00002',
    designation: 'Administrator',
    role: 'Admin'
  }));
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({})
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));

  expect(screen.queryByRole('button', { name: 'Manage Employee' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add Manager' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Query Bucket' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add Holiday' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Support' })).toBeInTheDocument();
});

test('superadmin attendance search can be expanded and hidden when needed', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  global.fetch = jest.fn((url) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    if (url.includes('/api/attendance') && url.includes('search_emp_code=MAS10001')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{
          UserID: 'MAS10001',
          Name: 'Search Employee',
          Designation: 'Engineer',
          Role: 'Employee',
          AttendanceDate: '2026-06-01',
          WorkingMinutes: 600
        }])
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');

  expect(screen.queryByLabelText('Employee Code')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Find Employee' }));
  fireEvent.change(screen.getByLabelText('Employee Code'), {
    target: { value: 'mas10001' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search Attendance' }));

  expect(await screen.findByText('Showing attendance for Search Employee')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide Search' }));

  expect(screen.queryByLabelText('Employee Code')).not.toBeInTheDocument();
  expect(screen.getByText('Showing attendance for Search Employee')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Find Employee' })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});

test('superadmin can search employees in Manage Employee', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));
  const employeeRows = [{
    id: 3,
    emp_name: 'Existing Employee',
    designation: 'Engineer',
    role: 'Employee',
    emp_code: 'MAS10003',
    process_name: 'Operations',
    lob_name: 'Voice',
    status: 'Active'
  }, {
    id: 4,
    emp_name: 'Second Employee',
    designation: 'Analyst',
    role: 'Employee',
    emp_code: 'MAS10004',
    process_name: 'Sales',
    lob_name: 'Chat',
    status: 'Inactive'
  }];

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({})
      });
    }
    if (url.includes('/api/employees')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(employeeRows)
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));

  expect(screen.getByRole('button', { name: 'Manage Employee' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add Manager' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Query Bucket' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add Holiday' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Support' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Manage Employee' }));
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/employees',
      expect.any(Object)
    );
  });
  expect(screen.queryByText('Existing Employee')).not.toBeInTheDocument();
  expect(screen.queryByText('Second Employee')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Search by ID'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('Existing Employee')).toBeInTheDocument();
  expect(screen.queryByText('Second Employee')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Search by ID'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Search by Name'), { target: { value: 'Existing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('Existing Employee')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
});

test('superadmin can add a manager to the Managers table', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({})
      });
    }
    if (url.endsWith('/api/managers') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({
          id: 12,
          manager_empcode: 'MAS20001',
          manager_name: 'New Manager',
          process_name: 'Operations',
          manager_unique_code: 'MGR-OPS-01'
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Manager' }));

  const managerPanel = screen.getByRole('heading', { name: 'Add Manager' }).closest('section');
  expect(screen.getByText('ID: Auto generated')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Manager_empcode'), {
    target: { value: 'mas20001' }
  });
  fireEvent.change(screen.getByLabelText('Manager_Name'), {
    target: { value: 'New Manager' }
  });
  fireEvent.change(screen.getByLabelText('Process_name'), {
    target: { value: 'Operations' }
  });
  fireEvent.change(screen.getByLabelText('managar_unique_code'), {
    target: { value: 'mgr-ops-01' }
  });
  fireEvent.click(within(managerPanel).getByRole('button', { name: 'Add Manager' }));

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Manager MAS20001 added successfully with ID 12.'
  );
  expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/api/managers',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        manager_empcode: 'MAS20001',
        manager_name: 'New Manager',
        process_name: 'Operations',
        manager_unique_code: 'MGR-OPS-01'
      })
    })
  );
});

test('superadmin can edit and delete managers from the manager list', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  const existingManager = {
    id: 7,
    manager_empcode: 'MAS20007',
    manager_name: 'Existing Manager',
    process_name: 'Operations',
    manager_unique_code: 'MGR-OPS-07'
  };

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({})
      });
    }
    if (url.includes('/api/managers/7') && options.method === 'PUT') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ...existingManager,
          process_name: 'Senior Operations'
        })
      });
    }
    if (url.includes('/api/managers/7') && options.method === 'DELETE') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: 'Manager deleted' })
      });
    }
    if (url.endsWith('/api/managers')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([existingManager])
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Manager' }));

  expect(await screen.findByText('Existing Manager')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('heading', { name: 'Edit Manager' })).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue('Operations'), {
    target: { value: 'Senior Operations' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Update Manager' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/managers/7',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          manager_empcode: 'MAS20007',
          manager_name: 'Existing Manager',
          process_name: 'Senior Operations',
          manager_unique_code: 'MGR-OPS-07'
        })
      })
    );
  });

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Manager MAS20007 deleted successfully.')).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/api/managers/7',
    expect.objectContaining({ method: 'DELETE' })
  );
  expect(screen.queryByText('Existing Manager')).not.toBeInTheDocument();
});

test('superadmin can bulk assign and remove employees for a manager', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  const manager = {
    id: 7,
    manager_empcode: 'MAS20007',
    manager_name: 'Operations Manager',
    process_name: 'Operations',
    manager_unique_code: 'MGR-OPS-07'
  };
  let assignmentRows = [{
    id: 21,
    emp_name: 'Assigned Employee',
    designation: 'Engineer',
    role: 'Employee',
    emp_code: 'MAS10021',
    assigned_manager_unique_code: 'MGR-OPS-07',
    assigned_manager_name: 'Operations Manager'
  }, {
    id: 22,
    emp_name: 'Available Employee',
    designation: 'Analyst',
    role: 'Employee',
    emp_code: 'MAS10022',
    assigned_manager_unique_code: null,
    assigned_manager_name: null
  }];

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({})
      });
    }
    if (url.endsWith('/api/managers')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([manager])
      });
    }
    if (url.includes('/api/managers/7/assignment-employees?assigned_only=true')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(
          assignmentRows.filter((employee) => (
            employee.assigned_manager_unique_code === 'MGR-OPS-07'
          ))
        )
      });
    }
    if (
      url.includes('/api/managers/7/assignment-employees?')
      && !url.includes('assigned_only=true')
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(assignmentRows.filter((employee) => {
          const isNotAssignedToManager = (
            employee.assigned_manager_unique_code !== 'MGR-OPS-07'
          );
          if (!url.includes('search_name=Available')) return isNotAssignedToManager;
          return isNotAssignedToManager && employee.emp_name === 'Available Employee';
        }))
      });
    }
    if (url.includes('/api/managers/7/assign-employees') && options.method === 'POST') {
      assignmentRows = assignmentRows.map((employee) => (
        employee.id === 22
          ? {
            ...employee,
            assigned_manager_unique_code: 'MGR-OPS-07',
            assigned_manager_name: 'Operations Manager'
          }
          : employee
      ));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          message: '1 employee(s) assigned',
          updated_count: 1
        })
      });
    }
    if (url.includes('/api/managers/7/remove-employees') && options.method === 'POST') {
      assignmentRows = assignmentRows.map((employee) => (
        employee.id === 21
          ? {
            ...employee,
            assigned_manager_unique_code: null,
            assigned_manager_name: null
          }
          : employee
      ));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          message: '1 employee assignment(s) removed',
          updated_count: 1
        })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Manager' }));
  await screen.findByText('Operations Manager');
  fireEvent.click(screen.getByRole('button', { name: 'Assign Employees' }));

  expect(await screen.findByText('Assigned Employee')).toBeInTheDocument();
  expect(await screen.findByText('Available Employee')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search by Name'), {
    target: { value: 'Available' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByText('Available Employee')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /Available Employee/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Assign Selected (1)' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/managers/7/assign-employees',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ employee_ids: [22] })
      })
    );
  });
  expect(await screen.findByText('1 employee(s) assigned')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox', { name: /Assigned Employee/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Selected (1)' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/managers/7/remove-employees',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ employee_ids: [21] })
      })
    );
  });
  expect(await screen.findByText('1 employee assignment(s) removed')).toBeInTheDocument();
});

test('superadmin can paste comma-separated EmpCodes and assign selected employees', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  const manager = {
    id: 8,
    manager_empcode: 'MAS20008',
    manager_name: 'Bulk Manager',
    process_name: 'Sales',
    manager_unique_code: 'MGR-SALES-08'
  };
  const bulkEmployees = [{
    id: 31,
    emp_name: 'First Bulk Employee',
    designation: 'Executive',
    role: 'Employee',
    emp_code: 'MAS10031',
    assigned_manager_unique_code: null,
    assigned_manager_name: null
  }, {
    id: 32,
    emp_name: 'Second Bulk Employee',
    designation: 'Executive',
    role: 'Employee',
    emp_code: 'MAS10032',
    assigned_manager_unique_code: 'MGR-OTHER',
    assigned_manager_name: 'Other Manager'
  }];
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/api/managers')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([manager])
      });
    }
    if (url.includes('/api/managers/8/assignment-employees?assigned_only=true')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('emp_codes=MAS10031%2CMAS10032')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(bulkEmployees)
      });
    }
    if (
      url.includes('/api/managers/8/assignment-employees?')
      && !url.includes('assigned_only=true')
    ) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/managers/8/assign-employees') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          message: '2 employee(s) assigned',
          updated_count: 2
        })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Manager' }));
  await screen.findByText('Bulk Manager');
  fireEvent.click(screen.getByRole('button', { name: 'Assign Employees' }));

  fireEvent.change(screen.getByLabelText('Paste Employee Codes'), {
    target: { value: 'mas10031, mas10032, mas10031' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Find EmpCodes' }));

  expect(await screen.findByText('First Bulk Employee')).toBeInTheDocument();
  expect(screen.getByText('Second Bulk Employee')).toBeInTheDocument();
  const availableEmployeesColumn = screen
    .getByText('Available Employees')
    .closest('.assignment-column');
  fireEvent.click(within(availableEmployeesColumn).getByRole('button', { name: 'Select All' }));
  fireEvent.click(screen.getByRole('button', { name: 'Assign Selected (2)' }));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/managers/8/assign-employees',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ employee_ids: [31, 32] })
      })
    );
  });
});

test('superadmin can select and assign an entire Process to a manager', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  const manager = {
    id: 9,
    manager_empcode: 'MAS20009',
    manager_name: 'Process Manager',
    process_name: 'Operations',
    manager_unique_code: 'MGR-PROCESS-09'
  };
  const processEmployees = [{
    id: 41,
    emp_name: 'Process Employee One',
    designation: 'Executive',
    role: 'Employee',
    emp_code: 'MAS10041',
    assigned_manager_unique_code: null,
    assigned_manager_name: null,
    process_name: 'Bella-Vita Organic',
    lob_name: 'Inbound'
  }, {
    id: 42,
    emp_name: 'Process Employee Two',
    designation: 'Executive',
    role: 'Employee',
    emp_code: 'MAS10042',
    assigned_manager_unique_code: 'MGR-OTHER',
    assigned_manager_name: 'Other Manager',
    process_name: 'Bella-Vita Organic',
    lob_name: 'Repeat Customer LOB'
  }];
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/api/managers')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([manager])
      });
    }
    if (url.endsWith('/api/agent-process/options')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          processes: ['Bella-Vita Organic', 'Housing.com Owner'],
          lobs: ['Inbound', 'Repeat Customer LOB'],
          lobs_by_process: {
            'Bella-Vita Organic': ['Inbound', 'Repeat Customer LOB'],
            'Housing.com Owner': ['Owner']
          }
        })
      });
    }
    if (url.includes('/api/managers/9/assignment-employees?assigned_only=true')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('process_name=Bella-Vita+Organic')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(processEmployees)
      });
    }
    if (
      url.includes('/api/managers/9/assignment-employees?')
      && !url.includes('assigned_only=true')
    ) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/managers/9/assign-employees') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          message: '2 employee(s) assigned',
          updated_count: 2
        })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Manager' }));
  await screen.findByText('Process Manager');
  fireEvent.click(screen.getByRole('button', { name: 'Assign Employees' }));

  await screen.findByRole('option', { name: 'Bella-Vita Organic' });
  fireEvent.change(screen.getByLabelText('Process Name'), {
    target: { value: 'Bella-Vita Organic' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load & Select Whole Group' }));

  expect(await screen.findByText('Process Employee One')).toBeInTheDocument();
  expect(screen.getByText('Process Employee Two')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Assign Selected (2)' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Assign Selected (2)' }));

  expect(window.confirm).toHaveBeenCalledWith(
    'Some selected employees already have a manager. Move them to this manager?'
  );
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/managers/9/assign-employees',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ employee_ids: [41, 42] })
      })
    );
  });
});

test('LOB assignment requires a Process and only shows LOBs from that Process', async () => {
  localStorage.setItem('token', 'header.eyJzdWIiOiJNQVMwMDAwMSIsInJvbGUiOiJTdXBlckFkbWluIn0.signature');
  localStorage.setItem('attendanceProfileV2', JSON.stringify({
    name: 'Super Admin',
    emp_code: 'MAS00001',
    designation: 'Administrator',
    role: 'SuperAdmin'
  }));

  const manager = {
    id: 10,
    manager_empcode: 'MAS20010',
    manager_name: 'LOB Manager',
    process_name: 'Operations',
    manager_unique_code: 'MGR-LOB-10'
  };
  const lobEmployees = [{
    id: 51,
    emp_name: 'Inbound Employee',
    designation: 'Executive',
    role: 'Employee',
    emp_code: 'MAS10051',
    assigned_manager_unique_code: null,
    assigned_manager_name: null,
    process_name: 'Bella-Vita Organic',
    lob_name: 'Inbound'
  }];

  global.fetch = jest.fn((url) => {
    if (url.includes('/api/profile')) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    if (url.endsWith('/api/managers')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([manager])
      });
    }
    if (url.endsWith('/api/agent-process/options')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          processes: ['Bella-Vita Organic', 'Housing.com Owner'],
          lobs: ['Inbound', 'Owner', 'Repeat Customer LOB'],
          lobs_by_process: {
            'Bella-Vita Organic': ['Inbound', 'Repeat Customer LOB'],
            'Housing.com Owner': ['Owner']
          }
        })
      });
    }
    if (url.includes('/api/managers/10/assignment-employees?assigned_only=true')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (
      url.includes('process_name=Bella-Vita+Organic')
      && url.includes('lob_name=Inbound')
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(lobEmployees)
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  });

  render(<App />);
  await screen.findByTestId('calendar');
  fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Manager' }));
  await screen.findByText('LOB Manager');
  fireEvent.click(screen.getByRole('button', { name: 'Assign Employees' }));

  await screen.findByRole('option', { name: 'Bella-Vita Organic' });
  fireEvent.change(screen.getByLabelText('Group Type'), { target: { value: 'lob' } });

  expect(screen.getByLabelText('LOB Name')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Process Name'), {
    target: { value: 'Bella-Vita Organic' }
  });

  expect(screen.getByLabelText('LOB Name')).toBeEnabled();
  expect(screen.getByRole('option', { name: 'Inbound' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Repeat Customer LOB' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('LOB Name'), { target: { value: 'Inbound' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load & Select Whole Group' }));

  expect(await screen.findByText('Inbound Employee')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Assign Selected (1)' })).toBeEnabled();
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('process_name=Bella-Vita+Organic'),
    expect.any(Object)
  );
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('lob_name=Inbound'),
    expect.any(Object)
  );
});
