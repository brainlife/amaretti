jwt=`cat ~/.sca/keys/cli.jwt`

curl \
    -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" \
    -X POST https://soichi7.ppa.iu.edu/api/sca/task -d '
{
    "instance_id": "570d1ef166a1e2fc1ef5a847",
    "service": "soichih/sca-product-raw",
    "config": {
        "tar": [
            {"src": "/N/dc2/scratch/odiuser/SPIE_MasterCals_headers", "dest": "backup.tar.gz", "opts": "gz"}
        ]
    }
}'
