import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

const connectSocket = (token: string) => {
  socket = io(process.env.NEXT_PUBLIC_SOCKET_URL!, { auth: { token } });
  socket.on("connect", () => {
      socket?.emit("presence:subscribe")
      console.log("socket connected");
  });
  socket.on("connect_error", (e) => {
    console.log("socket error:", e.message);
  });

  return socket;
};

const getSocket = (): Socket | null => socket;

const disconnectSocket = () => {
  socket?.disconnect();
  socket = null;
};

export { connectSocket, getSocket, disconnectSocket };
