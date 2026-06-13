import React, { useCallback, useEffect, useState } from 'react';

function ApplicationAccess({ apiBaseUrl, token, currentEmpCode }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [summary, setSummary] = useState({
    active_count: 0,
    inactive_count: 0,
    total_count: 0
  });
  const [loading, setLoading] = useState(true);
  const [updatingCode, setUpdatingCode] = useState('');
  const [message, setMessage] = useState('');

  const loadUsers = useCallback(async (searchValue = '') => {
    setLoading(true);
    setMessage('');
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (searchValue.trim()) params.set('search', searchValue.trim());
      const response = await fetch(
        `${apiBaseUrl}/api/application-access?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to load application access');
      }
      setUsers(data.users || []);
      setSummary({
        active_count: data.active_count || 0,
        inactive_count: data.inactive_count || 0,
        total_count: data.total_count || 0
      });
    } catch (error) {
      setUsers([]);
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    loadUsers('');
  }, [loadUsers]);

  const submitSearch = (event) => {
    event.preventDefault();
    setSubmittedSearch(search.trim());
    loadUsers(search);
  };

  const clearSearch = () => {
    setSearch('');
    setSubmittedSearch('');
    loadUsers('');
  };

  const changeAccess = async (user) => {
    const nextStatus = user.status === 'Active' ? 'Inactive' : 'Active';
    if (
      nextStatus === 'Inactive'
      && !window.confirm(`Deactivate application access for ${user.name}?`)
    ) {
      return;
    }

    setUpdatingCode(user.emp_code);
    setMessage('');
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/application-access/${encodeURIComponent(user.emp_code)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ status: nextStatus })
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to update application access');
      }
      setMessage(`${data.name} is now ${data.status}.`);
      await loadUsers(submittedSearch);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUpdatingCode('');
    }
  };

  return (
    <section className="admin-panel access-panel">
      <div className="access-hero">
        <div>
          <span className="panel-kicker">SuperAdmin Security</span>
          <h2>Application Access</h2>
          <p>
            Choose which employees and managers are allowed to sign in.
            Inactive users are blocked immediately.
          </p>
        </div>
        <div className="access-summary">
          <div>
            <strong>{summary.total_count}</strong>
            <span>Total Accounts</span>
          </div>
          <div className="is-active">
            <strong>{summary.active_count}</strong>
            <span>Active</span>
          </div>
          <div className="is-inactive">
            <strong>{summary.inactive_count}</strong>
            <span>Inactive</span>
          </div>
        </div>
      </div>

      <form className="access-search" onSubmit={submitSearch}>
        <label>
          <span>Find Employee or Manager</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search EmpCode, name, or role"
          />
        </label>
        <button type="submit">Search Access</button>
        {(search || submittedSearch) && (
          <button type="button" className="access-clear-btn" onClick={clearSearch}>
            Clear
          </button>
        )}
      </form>

      {message && <div className="employee-form-message" role="status">{message}</div>}

      <div className="access-list">
        <div className="access-list-head">
          <span>EmpCode</span>
          <span>Name</span>
          <span>Role</span>
          <span>Account Type</span>
          <span>Access</span>
          <span>Action</span>
        </div>
        {users.map((user) => {
          const isCurrentUser = (
            user.emp_code.toUpperCase() === String(currentEmpCode || '').toUpperCase()
          );
          return (
            <div className="access-list-row" key={`${user.source}-${user.emp_code}`}>
              <strong>{user.emp_code}</strong>
              <span>{user.name}</span>
              <span>{user.role}</span>
              <span>{user.source}</span>
              <span className={`employee-status ${user.status.toLowerCase()}`}>
                {user.status}
              </span>
              <button
                type="button"
                className={user.status === 'Active' ? 'access-deactivate' : 'access-activate'}
                disabled={isCurrentUser || updatingCode === user.emp_code}
                title={isCurrentUser ? 'You cannot deactivate your own account' : ''}
                onClick={() => changeAccess(user)}
              >
                {updatingCode === user.emp_code
                  ? 'Updating...'
                  : user.status === 'Active' ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          );
        })}
        {!loading && users.length === 0 && (
          <div className="empty-list">No application accounts found.</div>
        )}
        {loading && <div className="empty-list">Loading access accounts...</div>}
      </div>
      <p className="access-note">
        Showing up to 200 accounts. Search by EmpCode or name to find a specific user.
      </p>
    </section>
  );
}

export default ApplicationAccess;
