// server/server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configura o Socket.IO para usar o servidor HTTP
const io = new Server(server, {
    cors: {
        origin: "*", // Permite conexões de qualquer origem (para desenvolvimento)
        methods: ["GET", "POST"]
    }
});

// Serve arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, '../public')));

// --- Lógica do Backend para Gerenciamento de Filas ---
let filas = {
    Normal: [],
    Prioritário: [],
    Retirada: []
};

// Mapeamento de atendentes logados para seus guichês e senhas atuais
let atendentesLogados = {}; // { atendenteId: { guiche: '1', senhaAtual: null } }

// Eventos do Socket.IO
io.on('connection', (socket) => {
    console.log(`Usuário conectado: ${socket.id}`);

    // Envia o estado inicial das filas para o cliente recém-conectado
    socket.emit('update-filas', filas);

    // Evento para gerar uma nova senha
    socket.on('gerar-senha', (tipo) => {
        // Adição para depuração: verifica o tipo recebido
        console.log(`Recebido pedido para gerar senha do tipo: '${tipo}'`);

        if (!filas[tipo]) {
            console.error(`Erro: Tipo de senha inválido recebido: '${tipo}'`);
            socket.emit('gerar-senha-error', `Tipo de atendimento inválido: ${tipo}`);
            return; // Sai da função se o tipo for inválido
        }

        const prefix = {'Normal':'N','Prioritário':'P','Retirada':'R'}[tipo];
        // Garante que o prefixo existe para o tipo
        if (!prefix) {
            console.error(`Erro: Prefixo não encontrado para o tipo: '${tipo}'`);
            socket.emit('gerar-senha-error', `Erro interno ao gerar senha para o tipo: ${tipo}`);
            return;
        }

        const num = filas[tipo].length + 1; // Número sequencial simples
        const numero = prefix + num.toString().padStart(3, '0');
        
        const novaSenha = { numero, tipo, geradaEm: new Date() };
        filas[tipo].push(novaSenha);
        
        // Notifica todos os clientes sobre a nova senha gerada e as filas atualizadas
        io.emit('senha-gerada', { senha: novaSenha, filas: filas });
        console.log(`Senha gerada: ${numero} (${tipo}). Filas:`, filas);
    });

    // Evento para chamar a próxima senha
    socket.on('chamar-senha', ({ tipo, guiche, atendenteId }) => {
        console.log(`Pedido para chamar senha do tipo: '${tipo}' no guichê '${guiche}' pelo atendente '${atendenteId}'`);

        if (!filas[tipo]) {
            socket.emit('chamar-error', `Tipo de fila inválido: ${tipo}`);
            console.error(`Erro: Tipo de fila inválido para chamar: '${tipo}'`);
            return;
        }

        if (filas[tipo].length > 0) {
            const senhaChamada = filas[tipo].shift(); // Remove da fila
            
            // Armazena a senha atual para o atendente
            if (!atendentesLogados[atendenteId]) {
                atendentesLogados[atendenteId] = {};
            }
            atendentesLogados[atendenteId].guiche = guiche;
            atendentesLogados[atendenteId].senhaAtual = senhaChamada;
            
            // Notifica todos os clientes sobre a senha chamada
            io.emit('senha-chamada', { 
                senha: senhaChamada, 
                guiche: guiche, 
                atendenteId: atendenteId, // Para o atendente saber que é a dele
                filas: filas 
            });
            console.log(`Senha ${senhaChamada.numero} (${senhaChamada.tipo}) chamada pelo Guichê ${guiche} (Atendente: ${atendenteId}). Filas:`, filas);
        } else {
            socket.emit('chamar-error', `Não há senhas do tipo ${tipo} na fila.`);
            console.log(`Tentativa de chamar senha ${tipo} falhou: fila vazia.`);
        }
    });

    // Evento para finalizar atendimento
    socket.on('finalizar-atendimento', ({ senha, atendenteId }) => {
        console.log(`Pedido para finalizar atendimento da senha '${senha?.numero}' pelo atendente '${atendenteId}'`);

        if (atendentesLogados[atendenteId] && atendentesLogados[atendenteId].senhaAtual && atendentesLogados[atendenteId].senhaAtual.numero === senha.numero) {
            // Limpa a senha atual do atendente
            atendentesLogados[atendenteId].senhaAtual = null;
            
            // Notifica todos os clientes que um atendimento foi finalizado
            io.emit('atendimento-finalizado', { 
                senha: senha, 
                atendenteId: atendenteId,
                filas: filas // Filas não mudam ao finalizar, mas enviamos para consistência
            });
            console.log(`Atendimento da senha ${senha.numero} finalizado pelo Atendente: ${atendenteId}.`);
        } else {
            socket.emit('finalizar-error', 'Nenhuma senha válida em atendimento para finalizar.');
            console.log(`Tentativa de finalizar atendimento falhou para atendente ${atendenteId}.`);
        }
    });

    // Evento para redirecionar senha
    socket.on('redirecionar-senha', ({ senha, novoTipo, atendenteId }) => {
        console.log(`Pedido para redirecionar senha '${senha?.numero}' para '${novoTipo}' pelo atendente '${atendenteId}'`);

        if (atendentesLogados[atendenteId] && atendentesLogados[atendenteId].senhaAtual && atendentesLogados[atendenteId].senhaAtual.numero === senha.numero) {
            if (filas[novoTipo]) {
                filas[novoTipo].push(senha); // Adiciona à nova fila
                atendentesLogados[atendenteId].senhaAtual = null; // Limpa a senha atual do atendente

                io.emit('redirecionar-sucesso', { 
                    senha: senha, 
                    novoTipo: novoTipo, 
                    atendenteId: atendenteId,
                    filas: filas 
                });
                console.log(`Senha ${senha.numero} redirecionada para ${novoTipo} pelo Atendente: ${atendenteId}. Filas:`, filas);
            } else {
                socket.emit('redirect-error', 'Tipo de redirecionamento inválido.');
                console.log(`Tentativa de redirecionar senha ${senha.numero} falhou: tipo inválido ${novoTipo}.`);
            }
        } else {
            socket.emit('redirect-error', 'Nenhuma senha válida em atendimento para redirecionar.');
            console.log(`Tentativa de redirecionar senha falhou para atendente ${atendenteId}.`);
        }
    });

    // Evento de desconexão
    socket.on('disconnect', () => {
        console.log(`Usuário desconectado: ${socket.id}`);
        // Em uma aplicação real, você também removeria o atendenteLogado se ele se desconectasse
    });
});

// Inicia o servidor na porta 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
