"""Run the standalone learning operator UI."""
import threading
import webbrowser
import uvicorn
from ursa_learning.config import get_settings


def main():
    settings = get_settings()
    if settings.open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{settings.host}:{settings.port}")).start()
    uvicorn.run("ursa_learning.app:create_app", factory=True, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
