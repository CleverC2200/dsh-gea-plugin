const form = document.querySelector('#setup');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  const status = document.querySelector('#status');
  button.disabled = true;
  status.textContent = '正在启动工作台…';
  try {
    const result = await window.desktopSetup.save(Object.fromEntries(new FormData(form)));
    if (!result.ok) throw new Error(result.error);
  } catch(error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
