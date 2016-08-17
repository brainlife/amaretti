openssl genrsa -out wf.key 2048
openssl rsa -in wf.key -pubout > wf.pub
