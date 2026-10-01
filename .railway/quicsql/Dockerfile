FROM busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e AS release
ADD --checksum=sha256:73b63b16fdf9a4d3d807e2f342a876c5801bfda0a15366f89818322638baaeae https://github.com/quicsql/quicsql/releases/download/v0.6.0/quicsql_0.6.0_linux_amd64.tar.gz /tmp/quicsql.tar.gz
RUN mkdir /release && tar -xzf /tmp/quicsql.tar.gz -C /release

FROM busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
COPY --from=release /release/quicsql /usr/local/bin/quicsql
COPY --from=release /release/LICENSE /usr/share/licenses/quicsql/LICENSE
COPY quicsql.yaml /etc/quicsql.yaml
WORKDIR /var/lib/sqld/quicsql
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/quicsql", "--config", "/etc/quicsql.yaml"]
