import express from "express";
import * as http from "http";
import * as Websocket from "ws";
import cors from "cors";
import { WebsocketConnection } from "./ws";
import dotenv from "dotenv";

(async () => {
  dotenv.config();
  const app = express();

  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.use(express.json());

  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (req, res) => {
    res.status(200).send("Server is running");
  });

  const server = http.createServer(app);
  const websocket = new Websocket.Server({ server, path: "/ws" });

  WebsocketConnection(websocket);

  const port = process.env.PORT || 8000;
  server.listen(port, () => {
    console.log(`Server started on port ${port}`);
  });
})();
