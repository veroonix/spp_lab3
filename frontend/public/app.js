const form = document.querySelector('#bookForm');
const grid = document.querySelector('#bookGrid');
const emptyState = document.querySelector('#emptyState');
const formMessage = document.querySelector('#formMessage');
const cancelButton = document.querySelector('#cancelButton');
const genreSelect = document.querySelector('#genre');
const loginForm = document.querySelector('#loginForm');
const registerForm = document.querySelector('#registerForm');
const showRegisterButton = document.querySelector('#showRegisterButton');
const showLoginButton = document.querySelector('#showLoginButton');
const userForm = document.querySelector('#userForm');
const userMessage = document.querySelector('#userMessage');
const adminSessionPanel = document.querySelector('#adminSessionPanel');
const adminSessionRows = document.querySelector('#adminSessionRows');
const sessionMessage = document.querySelector('#sessionMessage');
const recoveryForm = document.querySelector('#recoveryForm');
const resetPasswordForm = document.querySelector('#resetPasswordForm');
const authMessage = document.querySelector('#authMessage');
const logoutButton = document.querySelector('#logoutButton');
const authState = document.querySelector('#authState');
const recoverButton = document.querySelector('#recoverButton');
const logoutAllButton = document.querySelector('#logoutAllButton');
const refreshSessionsButton = document.querySelector('#refreshSessionsButton');
const cancelRecoveryButton = document.querySelector('#cancelRecoveryButton');
const cancelResetButton = document.querySelector('#cancelResetButton');

const GENRES = [
  'Фантастика',
  'Детектив',
  'Роман',
  'Приключения',
  'Фэнтези',
  'История',
  'Научпоп',
  'Мистика',
  'Классика',
  'Бизнес',
  'Психология',
  'Детская',
];

let books = [];
let currentUser = JSON.parse(localStorage.getItem('libraryUser') || 'null');
let authToken = localStorage.getItem('libraryToken');
let registrationMode = false;
let recoveryMode = false;
let resetToken = null;

function showMessage(text, type = 'error') {
  formMessage.textContent = text;
  formMessage.className = `message ${type}`;
}

function showAuthMessage(text, type = 'success') {
  authMessage.textContent = text;
  authMessage.className = `message ${type}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function populateGenres() {
  genreSelect.innerHTML = ['<option value="">Выберите жанр</option>']
    .concat(
      GENRES.map(
        (genre) => `<option value="${escapeHtml(genre)}">${escapeHtml(genre)}</option>`,
      ),
    )
    .join('');
}

async function request(url, options) {
  const requestOptions = { ...options, headers: new Headers(options?.headers || {}) };
  if (authToken) {
    requestOptions.headers.set('Authorization', `Bearer ${authToken}`);
  }
  const response = await fetch(url, requestOptions);
  const payload = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
    }
    throw new Error(payload?.error || 'Сервер вернул ошибку');
  }

  return payload;
}

function render() {
  emptyState.classList.toggle('hidden', books.length !== 0);

  grid.innerHTML = books
    .map(
      (book) => `
        <article class="book-card">
          <div class="cover">
            ${
              book.coverUrl
                ? `<img src="${book.coverUrl}" alt="Обложка книги ${escapeHtml(book.title)}">`
                : '<span>BOOK</span>'
            }
          </div>

          <div class="book-info">
            <span class="genre">${escapeHtml(book.genre)} · ${book.year}</span>
            <h3>${escapeHtml(book.title)}</h3>
            <p class="author">${escapeHtml(book.author)}</p>
            <p class="description">${escapeHtml(book.description || 'Без описания')}</p>

            ${currentUser?.role === 'viewer' ? '' : `<div class="card-actions">
              <button data-edit="${book.id}" type="button">Изменить</button>
              ${currentUser?.role === 'admin' ? `<button data-delete="${book.id}" type="button">Удалить</button>` : ''}
            </div>`}
          </div>
        </article>
      `,
    )
    .join('');
}

async function loadBooks() {
  if (!authToken) {
    books = [];
    render();
    return;
  }
  try {
    books = await request('/api/books');
    render();
  } catch (error) {
    showMessage(error.message);
  }
}

function renderAdminSessions(users) {
  adminSessionRows.innerHTML = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${user.activeSessionCount}</td>
      <td><button class="session-action-button" data-revoke-sessions="${user.id}" type="button" ${user.activeSessionCount === 0 ? 'disabled' : ''}>Завершить сессии</button></td>
    </tr>
  `).join('');
}

async function loadAdminSessions() {
  const isAdmin = Boolean(authToken && currentUser?.role === 'admin');
  adminSessionPanel.classList.toggle('hidden', !isAdmin);
  if (!isAdmin) return;

  try {
    const users = await request('/api/admin/users');
    renderAdminSessions(users);
    sessionMessage.textContent = '';
  } catch (error) {
    sessionMessage.textContent = error.message;
    sessionMessage.className = 'message error';
  }
}

function clearSession() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('libraryToken');
  localStorage.removeItem('libraryUser');
  updateAuthState();
}

function startSession(payload) {
  authToken = payload.token;
  currentUser = payload.user;
  localStorage.setItem('libraryToken', authToken);
  localStorage.setItem('libraryUser', JSON.stringify(currentUser));
  updateAuthState();
}

function updateAuthState() {
  const authenticated = Boolean(authToken && currentUser);
  const resetMode = Boolean(resetToken);
  authState.textContent = authenticated
    ? `${currentUser.email} · роль: ${currentUser.role}`
    : 'Войдите, чтобы продолжить';
  loginForm.classList.toggle('hidden', authenticated || registrationMode || recoveryMode || resetMode);
  registerForm.classList.toggle('hidden', authenticated || !registrationMode);
  userForm.classList.toggle('hidden', !authenticated || currentUser.role !== 'admin');
  recoveryForm.classList.toggle('hidden', authenticated || !recoveryMode || resetMode);
  resetPasswordForm.classList.toggle('hidden', !resetMode);
  recoverButton.classList.toggle('hidden', authenticated || registrationMode || recoveryMode || resetMode);
  logoutButton.classList.toggle('hidden', !authenticated);
  logoutAllButton.classList.toggle('hidden', !authenticated);
  form.classList.toggle('hidden', !authenticated || currentUser.role === 'viewer');
  loadAdminSessions();
  render();
}

function handleResetToken() {
  resetToken = new URLSearchParams(window.location.search).get('resetToken');
}

function resetForm() {
  form.reset();
  document.querySelector('#bookId').value = '';
  document.querySelector('#formTitle').textContent = 'Добавить книгу';
  document.querySelector('#formEyebrow').textContent = 'Новая запись';
  document.querySelector('#submitButton').textContent = 'Добавить книгу';
  cancelButton.classList.add('hidden');
  genreSelect.value = '';
}

function editBook(id) {
  const book = books.find((item) => item.id === id);

  if (!book) {
    return;
  }

  const fields = ['title', 'author', 'year', 'genre', 'description'];
  fields.forEach((key) => {
    const element = document.querySelector(`#${key}`);
    if (element) {
      element.value = book[key];
    }
  });

  document.querySelector('#bookId').value = id;
  document.querySelector('#formTitle').textContent = 'Изменить книгу';
  document.querySelector('#formEyebrow').textContent = 'Редактирование';
  document.querySelector('#submitButton').textContent = 'Сохранить изменения';
  cancelButton.classList.remove('hidden');
  document.querySelector('#title').focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const id = document.querySelector('#bookId').value;
  const data = new FormData(form);

  try {
    await request(id ? `/api/books/${id}` : '/api/books', {
      method: id ? 'PUT' : 'POST',
      body: data,
    });

    resetForm();
    showMessage(id ? 'Изменения сохранены' : 'Книга добавлена', 'success');
    await loadBooks();
  } catch (error) {
    showMessage(error.message);
  }
});

grid.addEventListener('click', async (event) => {
  const editId = event.target.dataset.edit;
  const deleteId = event.target.dataset.delete;

  if (editId) {
    editBook(Number(editId));
  }

  if (deleteId && confirm('Удалить эту книгу?')) {
    try {
      await request(`/api/books/${deleteId}`, { method: 'DELETE' });
      await loadBooks();
    } catch (error) {
      showMessage(error.message);
    }
  }
});

cancelButton.addEventListener('click', resetForm);
showRegisterButton.addEventListener('click', () => {
  registrationMode = true;
  updateAuthState();
  document.querySelector('#registerEmail').focus();
});
showLoginButton.addEventListener('click', () => {
  registrationMode = false;
  updateAuthState();
  document.querySelector('#loginEmail').focus();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#loginEmail').value,
        password: document.querySelector('#loginPassword').value,
      }),
    });
    startSession(payload);
    loginForm.reset();
    await loadBooks();
  } catch (error) {
    showMessage(error.message);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#registerEmail').value,
        password: document.querySelector('#registerPassword').value,
      }),
    });
    registrationMode = false;
    startSession(payload);
    registerForm.reset();
    await loadBooks();
  } catch (error) {
    showMessage(error.message);
  }
});

userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  userMessage.textContent = '';
  try {
    const payload = await request('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#userEmail').value,
        password: document.querySelector('#userPassword').value,
        role: document.querySelector('#userRole').value,
      }),
    });
    userForm.reset();
    userMessage.textContent = `Создан аккаунт ${payload.user.email} с ролью ${payload.user.role}`;
    userMessage.className = 'message success';
    await loadAdminSessions();
  } catch (error) {
    userMessage.textContent = error.message;
    userMessage.className = 'message error';
  }
});

adminSessionRows.addEventListener('click', async (event) => {
  const userId = event.target.dataset.revokeSessions;
  if (!userId || !window.confirm('Завершить все активные сессии этого пользователя?')) return;

  try {
    const result = await request(`/api/admin/users/${userId}/sessions`, { method: 'DELETE' });
    sessionMessage.textContent = `Завершено сессий: ${result.revokedSessions}`;
    sessionMessage.className = 'message success';
    await loadAdminSessions();
  } catch (error) {
    sessionMessage.textContent = error.message;
    sessionMessage.className = 'message error';
  }
});

refreshSessionsButton.addEventListener('click', loadAdminSessions);

logoutButton.addEventListener('click', async () => {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
  }
});

logoutAllButton.addEventListener('click', async () => {
  if (!window.confirm('Завершить все ваши активные сессии на всех устройствах?')) return;
  try {
    await request('/api/auth/logout-all', { method: 'POST' });
    clearSession();
  } catch (error) {
    showMessage(error.message);
  }
});

recoverButton.addEventListener('click', async () => {
  recoveryMode = true;
  authMessage.textContent = '';
  updateAuthState();
  document.querySelector('#recoveryEmail').focus();
});

cancelRecoveryButton.addEventListener('click', () => {
  recoveryMode = false;
  authMessage.textContent = '';
  updateAuthState();
});

recoveryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await request('/api/auth/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.querySelector('#recoveryEmail').value }),
    });
    showAuthMessage(payload.resetToken
      ? `Локальный токен восстановления: ${payload.resetToken}`
      : payload.message);
  } catch (error) {
    showAuthMessage(error.message, 'error');
  }
});

resetPasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.querySelector('#newPassword').value;
  if (password !== document.querySelector('#confirmPassword').value) {
    showAuthMessage('Пароли не совпадают', 'error');
    return;
  }

  try {
    await request('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password }),
    });
    resetToken = null;
    resetPasswordForm.reset();
    window.history.replaceState({}, '', window.location.pathname);
    showAuthMessage('Пароль изменён. Теперь войдите с новым паролем');
    updateAuthState();
    document.querySelector('#loginEmail').focus();
  } catch (error) {
    showAuthMessage(error.message, 'error');
  }
});

cancelResetButton.addEventListener('click', () => {
  resetToken = null;
  window.history.replaceState({}, '', window.location.pathname);
  authMessage.textContent = '';
  updateAuthState();
});

populateGenres();
handleResetToken();
updateAuthState();
loadBooks();