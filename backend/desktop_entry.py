"""Private desktop backend. Its lifetime is tied to the parent's stdin pipe."""
import hmac
import os
import socket
import sys
import threading

import uvicorn
from starlette.responses import JSONResponse


class DesktopAccess:
    def __init__(self, app, token: str):
        self.app, self.token = app, token.encode('ascii')

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http':
            supplied = dict(scope['headers']).get(b'x-loredock-desktop', b'')
            if not hmac.compare_digest(supplied, self.token):
                await JSONResponse({'detail': 'Desktop access required.'}, 403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def main():
    token = os.environ.pop('LOREDOCK_DESKTOP_TOKEN', '')
    directory = os.environ.get('LOREDOCK_DATA_DIR', '')
    if len(token) < 32 or not directory:
        raise RuntimeError('Start this backend through the LoreDock desktop application.')
    # Set the data location before importing the existing web API module.
    from backend.app import app
    app.add_middleware(DesktopAccess, token=token)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', log_level='warning', access_log=False))

    def watch_parent():
        # EOF also arrives when the parent application crashes or is force-closed.
        sys.stdin.readline()
        server.should_exit = True

    threading.Thread(target=watch_parent, daemon=True).start()
    print('LOREDOCK_PORT=' + str(listener.getsockname()[1]), flush=True)
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    main()
