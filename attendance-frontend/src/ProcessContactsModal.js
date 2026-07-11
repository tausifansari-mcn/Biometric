import React, { useCallback, useEffect, useState } from 'react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emptyForm = { process_name: '', contact_name: '', email: '' };

function ProcessContactsModal({ apiBaseUrl, token, agentProcessOptions, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [formError, setFormError] = useState('');
  const [formMessage, setFormMessage] = useState('');

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/process-contacts`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ([]));
      if (!response.ok) throw new Error(data.detail || 'Failed to load contacts');
      setContacts(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormError('');
  };

  const startEdit = (contact) => {
    setForm({
      process_name: contact.process_name,
      contact_name: contact.contact_name,
      email: contact.email
    });
    setEditingId(contact.id);
    setFormError('');
    setFormMessage('');
  };

  const submitForm = async (event) => {
    event.preventDefault();
    if (!EMAIL_RE.test(form.email.trim())) {
      setFormError('Enter a valid email address');
      return;
    }
    setFormError('');
    try {
      const url = editingId
        ? `${apiBaseUrl}/api/process-contacts/${editingId}`
        : `${apiBaseUrl}/api/process-contacts`;
      const response = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          process_name: form.process_name.trim(),
          contact_name: form.contact_name.trim(),
          email: form.email.trim()
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to save contact');
      setFormMessage(editingId ? 'Contact updated' : 'Contact added');
      resetForm();
      fetchContacts();
    } catch (requestError) {
      setFormError(requestError.message);
    }
  };

  const deleteContact = async (contactId) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/process-contacts/${contactId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to delete contact');
      }
      if (editingId === contactId) resetForm();
      fetchContacts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card modal-card-wide">
        <h3>Manage Process Contacts</h3>
        <p className="modal-subtitle">
          This email is used to auto-fill the recipient when you send or schedule a report for that Process.
        </p>

        {loading && <div className="report-loading">Loading contacts...</div>}
        {error && <div className="report-error" role="alert">{error}</div>}

        {!loading && !error && (
          <div className="agent-report-table-wrap">
            <table className="agent-report-table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>{contact.process_name}</td>
                    <td>{contact.contact_name}</td>
                    <td>{contact.email}</td>
                    <td className="modal-table-actions">
                      <button type="button" onClick={() => startEdit(contact)}>Edit</button>
                      <button type="button" className="cancel-btn" onClick={() => deleteContact(contact.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {!contacts.length && (
                  <tr>
                    <td colSpan={4} className="agent-report-empty">No contacts yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={submitForm} className="modal-form modal-form-inline">
          <label>
            <span>Process</span>
            <select
              value={form.process_name}
              onChange={(event) => setForm((current) => ({ ...current, process_name: event.target.value }))}
              required
            >
              <option value="">Select Process</option>
              {agentProcessOptions.processes.map((option) => (
                <option value={option} key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Name</span>
            <input
              type="text"
              value={form.contact_name}
              onChange={(event) => setForm((current) => ({ ...current, contact_name: event.target.value }))}
              required
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              required
            />
          </label>
          {formError && <div className="report-error" role="alert">{formError}</div>}
          {formMessage && <div className="modal-success" role="status">{formMessage}</div>}
          <div className="modal-actions">
            {editingId && (
              <button type="button" className="cancel-btn" onClick={resetForm}>Cancel Edit</button>
            )}
            <button type="submit">{editingId ? 'Update Contact' : 'Add Contact'}</button>
          </div>
        </form>

        <div className="modal-actions">
          <button type="button" className="cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default ProcessContactsModal;
