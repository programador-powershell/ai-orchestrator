/**
 * Falha rápido se a porta do dev server estiver ocupada — o `next dev` não tem
 * strictPort (sobe em outra porta e o webview do Tauri abriria no vazio).
 */
import net from "node:net";

const port = Number(process.argv[2] ?? "1420");

const server = net.createServer();
server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Porta ${port} ocupada — feche o processo que a usa antes do tauri dev.`);
    process.exit(1);
  }
  console.error(String(error));
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));
