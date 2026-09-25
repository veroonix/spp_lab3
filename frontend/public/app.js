const form = document.querySelector('#bookForm');
const grid = document.querySelector('#bookGrid');
const emptyState = document.querySelector('#emptyState');
const formMessage = document.querySelector('#formMessage');
const cancelButton = document.querySelector('#cancelButton');
const genreSelect = document.querySelector('#genre');
const loginForm = document.querySelector('#loginForm');
const logoutButton = document.querySelector('#logoutButton');
const authState = document.querySelector('#authState');
const recoverButton = document.querySelector('#recoverButton');

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

function showMessage(text, type = 'error') {
  formMessage.textContent = text;
  formMessage.className = `message ${type}`;
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

function clearSession() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('libraryToken');
  localStorage.removeItem('libraryUser');
  updateAuthState();
}

function updateAuthState() {
  const authenticated = Boolean(authToken && currentUser);
  authState.textContent = authenticated
    ? `${currentUser.email} · роль: ${currentUser.role}`
    : 'Войдите, чтобы продолжить';
  loginForm.classList.toggle('hidden', authenticated);
  logoutButton.classList.toggle('hidden', !authenticated);
  form.classList.toggle('hidden', !authenticated || currentUser.role === 'viewer');
  render();
}

async function handleResetToken() {
  const token = new URLSearchParams(window.location.search).get('resetToken');
  if (!token) return;
  const password = window.prompt('Введите новый пароль (не менее 8 символов):');
  if (!password) return;
  try {
    await request('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    window.history.replaceState({}, '', window.location.pathname);
    showMessage('Пароль изменен. Войдите с новым паролем', 'success');
  } catch (error) {
    showMessage(error.message);
  }
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
    authToken = payload.token;
    currentUser = payload.user;
    localStorage.setItem('libraryToken', authToken);
    localStorage.setItem('libraryUser', JSON.stringify(currentUser));
    loginForm.reset();
    updateAuthState();
    await loadBooks();
  } catch (error) {
    showMessage(error.message);
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
  }
});

recoverButton.addEventListener('click', async () => {
  const email = window.prompt('Email для восстановления:');
  if (!email) return;
  try {
    const payload = await request('/api/auth/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    showMessage(payload.resetToken ? `Dev-токен: ${payload.resetToken}` : payload.message, 'success');
  } catch (error) {
    showMessage(error.message);
  }
});

populateGenres();
updateAuthState();
handleResetToken();
loadBooks();