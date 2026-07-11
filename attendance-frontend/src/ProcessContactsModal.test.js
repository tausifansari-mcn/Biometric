import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProcessContactsModal from './ProcessContactsModal';

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
          id: 2, process_name: 'Clovia', contact_name: 'Ashima', email: 'ashima.kapila@teammas.in'
        })
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(contacts)
    });
  });
});

test('lists existing process contacts', async () => {
  render(
    <ProcessContactsModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  expect(await screen.findByText('Rohan Kumar')).toBeInTheDocument();
  expect(screen.getByText('rohan@teammas.in')).toBeInTheDocument();
});

test('adds a new contact', async () => {
  render(
    <ProcessContactsModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  await screen.findByText('Rohan Kumar');
  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'Clovia' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ashima' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ashima.kapila@teammas.in' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Contact' }));

  await waitFor(() => expect(screen.getByText('Contact added')).toBeInTheDocument());

  const postCall = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(postCall[0]).toBe('http://localhost:8000/api/process-contacts');
  expect(JSON.parse(postCall[1].body)).toEqual({
    process_name: 'Clovia', contact_name: 'Ashima', email: 'ashima.kapila@teammas.in'
  });
});

test('rejects an invalid email without calling the API', async () => {
  render(
    <ProcessContactsModal
      apiBaseUrl="http://localhost:8000"
      token="test-token"
      agentProcessOptions={agentProcessOptions}
      onClose={() => {}}
    />
  );

  await screen.findByText('Rohan Kumar');
  fireEvent.change(screen.getByLabelText('Process'), { target: { value: 'Clovia' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ashima' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Contact' }));

  expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
  expect(global.fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
