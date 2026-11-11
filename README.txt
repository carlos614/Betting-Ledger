O outro README.md, é explicativo para instalação 
Realizando o teste pelo Windows 10.

Estou fazendo pelo docker postgres, junto com o bun para manter imagem do docker.

Fiz no visual studio code, instala o Bun for Visual Studio Code

Dentro do projeto pelo terminal powershell, faça:

	bun install

Fazendo isso, só é preciso usar o docker postgres


1. Inicie o PostgreSQL e o LocalStack:
	Powershell: docker compose up --build --scale app=3
	powershell: docker compose up -d postgres localstack

2. Para fazer a construção do projeto.

	porwershell: docker compose up -d --build app     

3. Inicie a aplicação:
	powershell: docker compose up -d app


4. Confira se está rodando:
	powershell: docker compose ps


5. Veja os logs:
	powershell: docker compose logs -f app

Cada inicialização do docker compose, é preciso alterar o localhost, Precisa ver pelo localhost:3000 até o 
localhost:3010, dai volta pro localhost:3000

pausar: docker compose stop ou ctrl + c.

	O sistema faz a comunição assincrona, via sqs, assim fazendo no servidor do docker, com postegres.
via docker, tem um tempo pra carregar, cerca de 810 m/s
Está fazendo o rollback, ganhou, perdeu e reembolso.
	Verificando a carteira do player também, exemplo:  carteira a564492b-07a9-42be-ae44-d4c08d43e7d3,
é possível carregar e verificar a carteira do outro player, ver toda a transação.
	Quando clicar em abrir Criar/abrir carteira, ela vai abrir a nova carteira zerada ou já vai ter
um valor do saldo.
	Se colocar outra outra moeda, ele vai reconhecer assim, gerando o valor em dolar, euro, real 
e afins.
	Por fim, coloquei as imagens do desafio para facilitar o entendimento.


